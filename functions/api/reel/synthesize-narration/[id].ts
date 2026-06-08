// POST /api/reel/synthesize-narration/[id]
// Synthesizes ElevenLabs narration for a completed reel piece and stores
// the mp3 in R2 at key narration/<piece_id>.mp3. Idempotent: if the row
// already has narration_status='ready', returns the existing payload.
//
// Body (all optional):
//   { voice_id?: string }   // override the persisted narration_voice_id
//
// Flow:
//   1. Read the piece row by id.
//   2. Require piece.status == 'completed'. Anything else is a 409.
//   3. Resolve voice: body.voice_id override -> piece.narration_voice_id
//      -> REEL_DEFAULT_VOICE_ID.
//   4. If piece.narration_status == 'ready' AND voice_id is unchanged,
//      return the existing url + panel_starts without re-billing.
//   5. Build narration text from beat_sheet.panels[].beat joined with
//      ". ". Compute each panel's start character offset (cumulative).
//   6. Call ElevenLabs /v1/text-to-speech/<voice_id>/with-timestamps.
//      Parse alignment to find each panel's start_time_seconds by
//      indexing into character_start_times_seconds[] at the offsets.
//   7. Upload mp3 to R2 under narration/<piece_id>.mp3.
//   8. UPDATE reel_pieces row with narration_*. Persist panel starts
//      as a JSON-stringified array. Bump narration_cost_usd.
//   9. Return { ok, url, voice_id, duration_seconds, panel_starts }.
//
// Cost model: ElevenLabs Starter is $5/mo for 30K chars, ~$0.00017/char.
// A 12-panel comic averages ~1KB of narration text. We log the estimated
// cost on the row for visibility; the real spend is metered upstream.

import {
  type ReelEnv,
  PIECE_ID_RE,
  REEL_DEFAULT_VOICE_ID,
  errorResponse,
  jsonResponse,
  resolveVoice,
} from "../../../_reel-shared.ts";

type Body = { voice_id?: string };

type PieceRow = {
  id: string;
  status: string;
  beat_sheet_json: string;
  mode: string;
  narration_voice_id: string | null;
  narration_url: string | null;
  narration_status: string | null;
  narration_duration_seconds: number | null;
  narration_panel_starts: string | null;
  narration_cost_usd: number | null;
};

type Panel = { index: number; beat: string; visual_prompt: string };
type BeatSheet = { title: string; logline: string; panels: Panel[] };

type ElevenLabsTimestamps = {
  audio_base64: string;
  alignment: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  } | null;
  normalized_alignment: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  } | null;
};

// ElevenLabs character-per-USD estimate for Starter tier. Used for the
// cost ledger only; the actual bill is metered server-side at ElevenLabs.
const COST_PER_CHARACTER_USD = 5 / 30000;

function base64ToBytes(b64: string): Uint8Array {
  // atob is available in Workers runtime.
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export const onRequestPost: PagesFunction<ReelEnv> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!id || !PIECE_ID_RE.test(id)) {
    return errorResponse(400, "bad_id", "piece id is malformed");
  }

  if (!ctx.env.ELEVENLABS_API_KEY) {
    return errorResponse(503, "service_unavailable", "Narration service is not yet configured");
  }

  let body: Body = {};
  try {
    const raw = await ctx.request.text();
    if (raw.trim()) body = JSON.parse(raw) as Body;
  } catch {
    return errorResponse(400, "bad_json", "Body must be JSON or empty");
  }

  const piece = await ctx.env.DB
    .prepare(
      `SELECT id, status, beat_sheet_json, mode,
              narration_voice_id, narration_url, narration_status,
              narration_duration_seconds, narration_panel_starts, narration_cost_usd
         FROM reel_pieces WHERE id = ?`,
    )
    .bind(id)
    .first<PieceRow>();

  if (!piece) {
    return errorResponse(404, "not_found", "no reel piece with that id");
  }
  if (piece.status !== "completed") {
    return errorResponse(
      409,
      "piece_not_ready",
      `narration can only be generated after the piece is completed (current: ${piece.status})`,
    );
  }

  const overrideRaw = (body.voice_id ?? "").trim();
  const resolvedOverride = overrideRaw ? resolveVoice(overrideRaw) : null;
  if (overrideRaw && !resolvedOverride) {
    return errorResponse(400, "invalid_voice_id", `voice_id "${overrideRaw}" is not a known narration voice`);
  }

  const voiceId =
    resolvedOverride?.id ?? piece.narration_voice_id ?? REEL_DEFAULT_VOICE_ID;
  const voice = resolveVoice(voiceId);
  if (!voice) {
    return errorResponse(500, "voice_resolution_failed", "narration voice could not be resolved");
  }

  // Idempotent short-circuit: same voice and already ready, just echo.
  if (
    piece.narration_status === "ready" &&
    piece.narration_url &&
    piece.narration_voice_id === voice.id
  ) {
    let panelStarts: number[] = [];
    try {
      panelStarts = piece.narration_panel_starts
        ? (JSON.parse(piece.narration_panel_starts) as number[])
        : [];
    } catch {
      panelStarts = [];
    }
    return jsonResponse({
      ok: true,
      cached: true,
      url: piece.narration_url,
      voice_id: voice.id,
      duration_seconds: piece.narration_duration_seconds ?? 0,
      panel_starts: panelStarts,
    });
  }

  let beatSheet: BeatSheet;
  try {
    beatSheet = JSON.parse(piece.beat_sheet_json) as BeatSheet;
  } catch {
    return errorResponse(500, "beat_sheet_parse_failed", "stored beat sheet is corrupt");
  }
  if (!beatSheet?.panels?.length) {
    return errorResponse(409, "no_panels", "beat sheet has no panels to narrate");
  }

  // Build narration text and the per-panel start offsets.
  // Format: "<beat 1>. <beat 2>. ... <beat N>."  with each beat trimmed
  // and terminating punctuation normalized to a single period. Panel N
  // starts at the cumulative character index of its first character.
  const sep = ". ";
  const beats = beatSheet.panels
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((p) => {
      let beat = (p.beat ?? "").trim();
      if (!beat) beat = `Panel ${p.index}`;
      // Strip trailing terminal punctuation so the sep can supply one period.
      beat = beat.replace(/[.!?…]+\s*$/u, "");
      return beat;
    });

  const panelCharOffsets: number[] = [];
  let cursor = 0;
  for (let i = 0; i < beats.length; i++) {
    panelCharOffsets.push(cursor);
    cursor += beats[i].length;
    if (i < beats.length - 1) cursor += sep.length;
  }
  const narrationText = beats.join(sep) + ".";

  if (narrationText.length > 4500) {
    return errorResponse(
      413,
      "narration_too_long",
      `narration text is ${narrationText.length} chars (cap 4500)`,
    );
  }

  // Mark attempt timestamp + status before the network call so a
  // mid-flight crash leaves a breadcrumb.
  await ctx.env.DB
    .prepare(
      `UPDATE reel_pieces
          SET narration_voice_id = ?,
              narration_status = 'in_flight',
              narration_attempted_at = ?
        WHERE id = ?`,
    )
    .bind(voice.id, new Date().toISOString(), id)
    .run();

  let elevenJson: ElevenLabsTimestamps;
  try {
    const elevenRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice.voice_id}/with-timestamps`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ctx.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: narrationText,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.75,
            style: 0.35,
            use_speaker_boost: true,
          },
        }),
      },
    );
    if (!elevenRes.ok) {
      const text = await elevenRes.text();
      await ctx.env.DB
        .prepare(`UPDATE reel_pieces SET narration_status = 'failed' WHERE id = ?`)
        .bind(id)
        .run();
      return errorResponse(
        502,
        "elevenlabs_error",
        `narration service returned ${elevenRes.status}: ${text.slice(0, 200)}`,
      );
    }
    elevenJson = (await elevenRes.json()) as ElevenLabsTimestamps;
  } catch (e) {
    await ctx.env.DB
      .prepare(`UPDATE reel_pieces SET narration_status = 'failed' WHERE id = ?`)
      .bind(id)
      .run();
    return errorResponse(502, "elevenlabs_network", `narration call failed: ${(e as Error).message}`);
  }

  if (!elevenJson.audio_base64) {
    await ctx.env.DB
      .prepare(`UPDATE reel_pieces SET narration_status = 'failed' WHERE id = ?`)
      .bind(id)
      .run();
    return errorResponse(502, "no_audio", "narration service returned no audio");
  }

  // Compute panel start times from character alignment. Prefer the
  // normalized_alignment if present (it matches the audio we're storing
  // after normalization); fall back to alignment otherwise.
  const align = elevenJson.normalized_alignment ?? elevenJson.alignment;
  const panelStarts: number[] = panelCharOffsets.map(() => 0);
  let durationSeconds = 0;
  if (align && Array.isArray(align.character_start_times_seconds)) {
    const starts = align.character_start_times_seconds;
    const ends = align.character_end_times_seconds;
    for (let i = 0; i < panelCharOffsets.length; i++) {
      const offset = Math.min(panelCharOffsets[i], starts.length - 1);
      panelStarts[i] = starts[offset] ?? 0;
    }
    if (Array.isArray(ends) && ends.length > 0) {
      durationSeconds = ends[ends.length - 1];
    }
  }

  // Upload mp3 to R2.
  const audioBytes = base64ToBytes(elevenJson.audio_base64);
  const r2Key = `narration/${id}.mp3`;
  try {
    await ctx.env.REEL_BUCKET.put(r2Key, audioBytes, {
      httpMetadata: { contentType: "audio/mpeg" },
    });
  } catch (e) {
    await ctx.env.DB
      .prepare(`UPDATE reel_pieces SET narration_status = 'failed' WHERE id = ?`)
      .bind(id)
      .run();
    return errorResponse(500, "r2_put_failed", `audio upload failed: ${(e as Error).message}`);
  }

  const audioUrl = `/audio-reel/${r2Key}`;
  const costUsd = narrationText.length * COST_PER_CHARACTER_USD;
  const prevCost = piece.narration_cost_usd ?? 0;

  try {
    await ctx.env.DB
      .prepare(
        `UPDATE reel_pieces
            SET narration_voice_id = ?,
                narration_url = ?,
                narration_duration_seconds = ?,
                narration_panel_starts = ?,
                narration_status = 'ready',
                narration_cost_usd = ?
          WHERE id = ?`,
      )
      .bind(
        voice.id,
        audioUrl,
        durationSeconds,
        JSON.stringify(panelStarts),
        prevCost + costUsd,
        id,
      )
      .run();
  } catch (e) {
    return errorResponse(500, "db_update_failed", `row update failed: ${(e as Error).message}`);
  }

  return jsonResponse({
    ok: true,
    cached: false,
    url: audioUrl,
    voice_id: voice.id,
    duration_seconds: durationSeconds,
    panel_starts: panelStarts,
  });
};
