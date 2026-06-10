// POST /api/cut/revise/<piece_id>
// Body: { message: string }   (1..MAX_REVISION_CHARS chars)
//
// Chat revision entry point. Only valid on a completed piece with
// revision_round < REVISION_CAP. Flow:
//   1. CAS the piece completed -> revising (the lock; concurrent calls 409).
//   2. Bridge /cut/route-edit classifies the message into ops.
//   3. ops empty  -> chat-only answer; piece returns to completed unchanged
//      (no revision round consumed).
//   4. ops present -> write composition version v+1 (append-only) and hand
//      the piece back to the status driver:
//        deterministic only (reorder/transition/retitle): artifacts survive,
//          shot rows are copied pre-accepted, piece -> stitching.
//        any generative op (regen/style): all artifacts + content hashes are
//          stripped from the new doc; fresh attempt-1 rows for every shot;
//          piece -> shooting. Untouched shots cache-hit by content hash
//          (free); regenerated shots and chain-invalidated downstream shots
//          re-render because their hash changes.
//   Every failure path restores status = completed.

import {
  type CutEnv,
  type CompositionDoc,
  type CompositionTransition,
  type EditOp,
  REVISION_CAP,
  MAX_REVISION_CHARS,
  PIECE_ID_RE,
  SHOT_ID_RE,
  bridgePost,
  jsonResponse,
  errorResponse,
  logEvent,
} from "../../../_cut-shared.ts";

type PieceRow = {
  id: string;
  slug: string;
  status: string;
  title: string | null;
  prompt_raw: string;
  current_version: number;
  revision_round: number;
  cost_usd: number;
};

type ShotRowLite = {
  shot_id: string;
  attempt: number;
  shot_order: number;
  prompt: string | null;
  conditioning_json: string | null;
  content_hash: string | null;
  video_key: string | null;
  sheet_key: string | null;
  frame_keys_json: string | null;
  last_frame_url: string | null;
  judge_json: string | null;
  score: number | null;
};

type RoutePlan = { ops: unknown[]; reply: string };

function clampXfade(d: unknown): number {
  const n = Number(d);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0.3, n));
}

// Validate + normalize the router's ops against the current doc. Invalid or
// unsupported ops are dropped; caps enforced (max 3 ops, 2 regens, 1 style).
function sanitizeOps(raw: unknown[], doc: CompositionDoc): EditOp[] {
  const shotIds = new Set(doc.shots.map((s) => s.id));
  const out: EditOp[] = [];
  let regens = 0;
  let styles = 0;
  for (const r of raw) {
    if (out.length >= 3) break;
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    switch (o.op) {
      case "reorder": {
        const order = Array.isArray(o.order) ? o.order.map(String) : [];
        if (order.length !== doc.shots.length) continue;
        if (new Set(order).size !== order.length) continue;
        if (!order.every((id) => shotIds.has(id))) continue;
        out.push({ op: "reorder", order });
        break;
      }
      case "transition": {
        const after = String(o.after ?? "");
        if (!doc.transitions.some((t) => t.after === after)) continue;
        const type = o.type === "xfade" ? "xfade" : "cut";
        out.push({
          op: "transition",
          after,
          type,
          duration: type === "xfade" ? clampXfade(o.duration) : 0,
        });
        break;
      }
      case "retitle": {
        const title = String(o.title ?? "").trim().slice(0, 120);
        if (!title) continue;
        out.push({ op: "retitle", title });
        break;
      }
      case "regen": {
        if (regens >= 2) continue;
        const shot = String(o.shot ?? "");
        const prompt = String(o.prompt ?? "").trim().slice(0, 1200);
        if (!SHOT_ID_RE.test(shot) || !shotIds.has(shot) || prompt.length < 20) continue;
        regens++;
        out.push({ op: "regen", shot, prompt });
        break;
      }
      case "style": {
        if (styles >= 1) continue;
        const styleBlock = String(o.style_block ?? "").trim().slice(0, 600);
        if (styleBlock.length < 10) continue;
        styles++;
        out.push({ op: "style", style_block: styleBlock });
        break;
      }
      default:
        // "trim" and anything else: unsupported, drop.
        continue;
    }
  }
  return out;
}

// Apply ops to a deep copy of the doc. Returns the new doc + whether any
// generative op touched it + the new title if retitled.
function applyOps(
  doc: CompositionDoc,
  ops: EditOp[],
): { next: CompositionDoc; generative: boolean; newTitle: string | null } {
  const next = JSON.parse(JSON.stringify(doc)) as CompositionDoc;
  let generative = false;
  let newTitle: string | null = null;

  for (const op of ops) {
    switch (op.op) {
      case "retitle":
        next.title = op.title;
        newTitle = op.title;
        break;
      case "transition": {
        const t = next.transitions.find((x) => x.after === op.after);
        if (t) {
          t.type = op.type;
          t.duration = op.type === "xfade" ? op.duration : 0;
        }
        break;
      }
      case "reorder": {
        // Re-sequence shots; junction i keeps its positional type/duration
        // but re-keys to the shot now occupying position i. Conditioning is
        // a historical record of how footage was generated; it does not get
        // rewired (deterministic reorder reuses existing footage as-is and
        // the final judge sees the seams honestly).
        const byId = new Map(next.shots.map((s) => [s.id, s]));
        const reordered = op.order.map((id) => byId.get(id)!);
        reordered.forEach((s, i) => {
          s.order = i;
        });
        next.shots = reordered;
        const oldT = next.transitions;
        next.transitions = reordered.slice(0, -1).map((s, i): CompositionTransition => ({
          after: s.id,
          type: oldT[i]?.type ?? "cut",
          duration: oldT[i]?.type === "xfade" ? oldT[i].duration : 0,
        }));
        break;
      }
      case "regen": {
        const s = next.shots.find((x) => x.id === op.shot);
        if (s) s.prompt = op.prompt;
        generative = true;
        break;
      }
      case "style":
        next.style_block = op.style_block;
        generative = true;
        break;
    }
  }
  return { next, generative, newTitle };
}

export const onRequestPost: PagesFunction<CutEnv> = async (ctx) => {
  const env = ctx.env;
  const id = String(ctx.params.id ?? "");
  if (!PIECE_ID_RE.test(id)) return errorResponse(400, "invalid_id", "Malformed piece id.");

  let body: Record<string, unknown>;
  try {
    body = (await ctx.request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "bad_json", "Body must be JSON.");
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return errorResponse(400, "missing_message", "Say what you want changed.");
  if (message.length > MAX_REVISION_CHARS) {
    return errorResponse(400, "message_too_long", `Keep it under ${MAX_REVISION_CHARS} characters.`);
  }

  const piece = await env.DB.prepare(
    `SELECT id, slug, status, title, prompt_raw, current_version, revision_round, cost_usd
       FROM cut_pieces WHERE id = ?1`,
  )
    .bind(id)
    .first<PieceRow>();
  if (!piece) return errorResponse(404, "not_found", "Unknown piece.");
  if (piece.revision_round >= REVISION_CAP) {
    return errorResponse(409, "revision_exhausted", `All ${REVISION_CAP} revisions are used.`);
  }
  if (piece.status !== "completed") {
    return errorResponse(409, "not_completed", "The piece is still being made. Revisions open when it completes.");
  }

  // The lock: completed -> revising. Loser of a race gets 409.
  const cas = await env.DB.prepare(
    `UPDATE cut_pieces SET status = 'revising' WHERE id = ?1 AND status = 'completed'`,
  )
    .bind(id)
    .run();
  if ((cas.meta.changes ?? 0) === 0) {
    return errorResponse(409, "busy", "Another revision is already in flight.");
  }

  const restoreCompleted = async () => {
    await env.DB.prepare(
      `UPDATE cut_pieces SET status = 'completed' WHERE id = ?1 AND status = 'revising'`,
    )
      .bind(id)
      .run();
  };

  try {
    const v = piece.current_version;
    const docRow = await env.DB.prepare(
      `SELECT doc FROM cut_compositions WHERE piece_id = ?1 AND version = ?2`,
    )
      .bind(id, v)
      .first<{ doc: string }>();
    const doc = docRow ? (JSON.parse(docRow.doc) as CompositionDoc) : null;
    if (!doc) throw new Error("composition document missing");

    await logEvent(env, id, v, null, "stage_start", "revise", {
      round: piece.revision_round + 1,
      message: message.slice(0, 300),
    });

    const resp = await bridgePost<{ plan: RoutePlan; cost_usd: number }>(env, "/cut/route-edit", {
      piece_id: id,
      message,
      composition: {
        title: doc.title ?? piece.title ?? "",
        style_block: doc.style_block,
        shots: doc.shots.map((s) => ({ id: s.id, order: s.order, prompt: s.prompt })),
        transitions: doc.transitions,
      },
    });
    const reply = String(resp.plan?.reply ?? "").slice(0, 600);
    const routeCost = resp.cost_usd ?? 0;
    const ops = sanitizeOps(Array.isArray(resp.plan?.ops) ? resp.plan.ops : [], doc);

    if (ops.length === 0) {
      // Chat-only: answer, charge the router call, no round consumed.
      await env.DB.prepare(
        `UPDATE cut_pieces SET status = 'completed', cost_usd = cost_usd + ?1
          WHERE id = ?2 AND status = 'revising'`,
      )
        .bind(routeCost, id)
        .run();
      await logEvent(env, id, v, null, "stage_done", "revise", { ops: [], reply: reply.slice(0, 200) });
      return jsonResponse({
        ok: true,
        reply: reply || "No edit needed for that. Ask for a change to the shots, transitions, style, or title.",
        ops: [],
        revision_round: piece.revision_round,
        status: "completed",
      });
    }

    const { next, generative, newTitle } = applyOps(doc, ops);
    const nv = v + 1;
    next.version = nv;
    next.parent_version = v;
    next.revision_note = message.slice(0, 300);
    delete next.assembly; // every revision re-stitches

    if (generative) {
      // Strip artifacts + hashes: compose-time content addressing decides
      // what actually re-renders (untouched shots cache-hit for free).
      for (const s of next.shots) {
        delete s.artifact;
        delete s.content_hash;
      }
    }

    const stmts = [
      env.DB.prepare(
        `INSERT INTO cut_compositions (piece_id, version, doc, revision_note)
         VALUES (?1, ?2, ?3, ?4)`,
      ).bind(id, nv, JSON.stringify(next), message.slice(0, 300)),
    ];

    if (generative) {
      for (const s of next.shots) {
        stmts.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO cut_shots (piece_id, version, shot_id, attempt, shot_order, status)
             VALUES (?1, ?2, ?3, 1, ?4, 'composing')`,
          ).bind(id, nv, s.id, s.order),
        );
      }
    } else {
      // Deterministic: copy the accepted render rows forward pre-accepted so
      // the new version is self-consistent in cut_shots (UI reads by version).
      const accepted = await env.DB.prepare(
        `SELECT shot_id, attempt, shot_order, prompt, conditioning_json, content_hash,
                video_key, sheet_key, frame_keys_json, last_frame_url, judge_json, score
           FROM cut_shots
          WHERE piece_id = ?1 AND version = ?2 AND status = 'accepted'`,
      )
        .bind(id, v)
        .all<ShotRowLite>();
      const byShot = new Map((accepted.results ?? []).map((r) => [r.shot_id, r]));
      for (const s of next.shots) {
        const src = byShot.get(s.id);
        if (!src?.video_key) throw new Error(`shot ${s.id} has no accepted render to carry forward`);
        stmts.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO cut_shots
               (piece_id, version, shot_id, attempt, shot_order, status, decision,
                prompt, conditioning_json, content_hash, cached_from, video_key, sheet_key,
                frame_keys_json, last_frame_url, judge_json, score, completed_at)
             VALUES (?1, ?2, ?3, 1, ?4, 'accepted', 'accept',
                     ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, datetime('now'))`,
          ).bind(
            id,
            nv,
            s.id,
            s.order,
            src.prompt,
            src.conditioning_json,
            src.content_hash,
            `v${v}/a${src.attempt}`,
            src.video_key,
            src.sheet_key,
            src.frame_keys_json,
            src.last_frame_url,
            src.judge_json,
            src.score,
          ),
        );
      }
    }

    const nextStatus = generative ? "shooting" : "stitching";
    stmts.push(
      env.DB.prepare(
        `UPDATE cut_pieces
           SET status = ?1, current_version = ?2, revision_round = revision_round + 1,
               repair_used = 0, title = COALESCE(?3, title), cost_usd = cost_usd + ?4,
               state_json = NULL, dispatched_at_ms = NULL, completed_at = NULL
         WHERE id = ?5 AND status = 'revising'`,
      ).bind(nextStatus, nv, newTitle, routeCost, id),
    );

    await env.DB.batch(stmts);
    await logEvent(env, id, nv, null, "stage_done", "revise", {
      round: piece.revision_round + 1,
      ops,
      generative,
      next_status: nextStatus,
    });

    return jsonResponse({
      ok: true,
      reply: reply || (generative ? "Re-shooting the touched shots, then re-cutting." : "Re-cutting with your change."),
      ops,
      revision_round: piece.revision_round + 1,
      status: nextStatus,
    });
  } catch (e) {
    await restoreCompleted();
    await logEvent(env, id, piece.current_version, null, "stage_fail", "revise", {
      message: (e as Error).message.slice(0, 300),
    });
    return errorResponse(502, "revise_failed", "Could not route that revision. The piece is unchanged; try again.");
  }
};
