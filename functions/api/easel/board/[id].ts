// GET /api/easel/board/<id>          — fetch board doc + version.
//   ?since=<version> returns {unchanged:true} when version matches (1Hz poll).
// PUT /api/easel/board/<id>          — save board doc.
//   Body: { doc, base_version, title? }
//   409 on version conflict; returns { ok: true, version } on success.

import type { EaselEnv } from "../../../_easel-shared";
import {
  BOARD_ID_RE,
  MAX_DOC_BYTES,
  MAX_TITLE_CHARS,
  errorResponse,
  jsonResponse,
  validateDoc,
} from "../../../_easel-shared";

type BoardRow = {
  id: string;
  title: string;
  doc: string;
  version: number;
  is_public: number;
  created_at: string;
  updated_at: string;
};

export const onRequestGet: PagesFunction<EaselEnv, "id"> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!BOARD_ID_RE.test(id)) return errorResponse(400, "bad_id", "malformed board id");

  const row = await ctx.env.DB.prepare(
    `SELECT id, title, doc, version, is_public, created_at, updated_at
     FROM easel_boards WHERE id = ?1`,
  ).bind(id).first<BoardRow>();
  if (!row) return errorResponse(404, "not_found", "no such board");

  const url = new URL(ctx.request.url);
  const since = Number(url.searchParams.get("since") ?? NaN);
  if (Number.isFinite(since) && since === row.version) {
    return jsonResponse({ ok: true, unchanged: true, version: row.version });
  }

  return jsonResponse({
    ok: true,
    id: row.id,
    title: row.title,
    version: row.version,
    doc: JSON.parse(row.doc),
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
};

export const onRequestPut: PagesFunction<EaselEnv, "id"> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!BOARD_ID_RE.test(id)) return errorResponse(400, "bad_id", "malformed board id");

  let body: { doc?: unknown; base_version?: unknown; title?: unknown };
  try {
    body = await ctx.request.json();
  } catch {
    return errorResponse(400, "bad_json", "body must be JSON");
  }

  const baseVersion = Number(body.base_version);
  if (!Number.isInteger(baseVersion) || baseVersion < 1) {
    return errorResponse(400, "bad_version", "base_version required");
  }

  const docJson = JSON.stringify(body.doc ?? null);
  if (docJson.length > MAX_DOC_BYTES) {
    return errorResponse(413, "doc_too_large", `doc exceeds ${MAX_DOC_BYTES} bytes`);
  }
  const v = validateDoc(body.doc);
  if (!v.ok) return errorResponse(422, "invalid_doc", v.reason);

  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, MAX_TITLE_CHARS)
      : null;

  // Optimistic concurrency: only write if version still matches.
  const result = await ctx.env.DB.prepare(
    `UPDATE easel_boards
     SET doc = ?1,
         version = version + 1,
         updated_at = datetime('now'),
         title = COALESCE(?2, title)
     WHERE id = ?3 AND version = ?4`,
  ).bind(JSON.stringify(v.doc), title, id, baseVersion).run();

  if (!result.meta.changes) {
    const row = await ctx.env.DB.prepare(
      `SELECT version FROM easel_boards WHERE id = ?1`,
    ).bind(id).first<{ version: number }>();
    if (!row) return errorResponse(404, "not_found", "no such board");
    return errorResponse(409, "version_conflict", `board is at version ${row.version}`);
  }

  return jsonResponse({ ok: true, version: baseVersion + 1 });
};
