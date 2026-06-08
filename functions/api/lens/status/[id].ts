// GET /api/lens/status/<id>
// Returns the current state of a generation. Lazily downloads Luma's image
// into R2 the first time we observe Luma report `completed`.

import {
  type LensEnv,
  errorResponse,
  fetchLumaImage,
  jsonResponse,
  lumaGet,
} from "../../../_lens-shared.ts";

type Row = {
  id: string;
  luma_id: string | null;
  prompt_raw: string;
  prompt_enhanced: string | null;
  model: string;
  aspect_ratio: string;
  status: string;
  failure_reason: string | null;
  r2_key: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  created_at: string;
  completed_at: string | null;
};

function publicUrl(id: string, base: URL): string {
  return `${base.origin}/i/${id}`;
}

export const onRequestGet: PagesFunction<LensEnv, "id"> = async (ctx) => {
  const id = ctx.params.id;
  if (typeof id !== "string" || !/^lg_[a-z0-9]{8,}$/.test(id)) {
    return errorResponse(400, "bad_id", "Bad generation id");
  }

  const row = await ctx.env.DB
    .prepare(
      `SELECT id, luma_id, prompt_raw, prompt_enhanced, model, aspect_ratio, status,
              failure_reason, r2_key, width, height, bytes, created_at, completed_at
         FROM lens_generations WHERE id = ?`,
    )
    .bind(id)
    .first<Row>();
  if (!row) return errorResponse(404, "not_found", "No such generation");

  const url = new URL(ctx.request.url);

  // Already terminal: short-circuit.
  if (row.status === "completed" && row.r2_key) {
    return jsonResponse({
      ok: true,
      id: row.id,
      status: "completed",
      prompt_raw: row.prompt_raw,
      prompt_enhanced: row.prompt_enhanced,
      model: row.model,
      aspect_ratio: row.aspect_ratio,
      url: publicUrl(row.id, url),
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      created_at: row.created_at,
      completed_at: row.completed_at,
    });
  }
  if (row.status === "failed" || row.status === "rejected") {
    return jsonResponse({
      ok: true,
      id: row.id,
      status: row.status,
      failure_reason: row.failure_reason,
      prompt_raw: row.prompt_raw,
      prompt_enhanced: row.prompt_enhanced,
      model: row.model,
      aspect_ratio: row.aspect_ratio,
    });
  }
  if (!row.luma_id) {
    return errorResponse(500, "missing_luma_id", "Generation missing upstream id");
  }

  // Poll Luma for current state.
  let luma;
  try {
    luma = await lumaGet(row.luma_id, ctx.env);
  } catch (e) {
    console.error("luma get failed:", (e as Error).message);
    return errorResponse(502, "luma_get_failed", "Could not check generation status");
  }

  // Still in-flight: just report state, leave row alone.
  if (luma.state === "queued" || luma.state === "processing") {
    if (row.status !== luma.state) {
      await ctx.env.DB
        .prepare("UPDATE lens_generations SET status = ? WHERE id = ?")
        .bind(luma.state, id)
        .run();
    }
    return jsonResponse({
      ok: true,
      id: row.id,
      status: luma.state,
      prompt_raw: row.prompt_raw,
      prompt_enhanced: row.prompt_enhanced,
      model: row.model,
      aspect_ratio: row.aspect_ratio,
    });
  }

  if (luma.state === "failed") {
    await ctx.env.DB
      .prepare(
        "UPDATE lens_generations SET status='failed', failure_reason=?, completed_at=datetime('now') WHERE id = ?",
      )
      .bind(luma.failure_reason ?? "unknown", id)
      .run();
    return jsonResponse({
      ok: true,
      id: row.id,
      status: "failed",
      failure_reason: luma.failure_reason,
      prompt_raw: row.prompt_raw,
      prompt_enhanced: row.prompt_enhanced,
      model: row.model,
      aspect_ratio: row.aspect_ratio,
    });
  }

  // Completed at Luma. Download + R2 upload.
  const srcUrl = luma.output?.[0]?.url;
  if (!srcUrl) {
    await ctx.env.DB
      .prepare(
        "UPDATE lens_generations SET status='failed', failure_reason='no_output_url', completed_at=datetime('now') WHERE id = ?",
      )
      .bind(id)
      .run();
    return errorResponse(502, "no_output_url", "Generation completed but no image URL");
  }

  let img;
  try {
    img = await fetchLumaImage(srcUrl);
  } catch (e) {
    console.error("download failed:", (e as Error).message);
    return errorResponse(502, "download_failed", "Could not download generated image");
  }

  const r2Key = `i/${id}.png`;
  await ctx.env.LENS_BUCKET.put(r2Key, img.bytes, {
    httpMetadata: {
      contentType: img.contentType,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      lens_id: id,
      luma_id: row.luma_id,
    },
  });

  await ctx.env.DB
    .prepare(
      `UPDATE lens_generations
          SET status='completed', r2_key=?, bytes=?, completed_at=datetime('now')
        WHERE id = ?`,
    )
    .bind(r2Key, img.bytes.byteLength, id)
    .run();

  return jsonResponse({
    ok: true,
    id: row.id,
    status: "completed",
    prompt_raw: row.prompt_raw,
    prompt_enhanced: row.prompt_enhanced,
    model: row.model,
    aspect_ratio: row.aspect_ratio,
    url: publicUrl(row.id, url),
    bytes: img.bytes.byteLength,
  });
};
