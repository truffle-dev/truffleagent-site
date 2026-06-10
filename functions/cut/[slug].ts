// GET /cut/<slug>/
// Finished piece page: the assembled cut plus the full direction receipt.
// Shows the final video, the EDL summary strip (shots + transitions + seam
// quality), per-shot verdicts, the seven-axis final judgment, and a chat
// revision rail ("Direct the next cut") that posts notes to the edit router.
// Redirects to the draft studio if the piece is still in flight; unknown
// slugs fall through to ctx.next() so static assets and the 404 serve.

import {
  type CutEnv,
  type JudgeVerdict,
  type CompositionDoc,
  type CompositionShot,
  CUT_AXES,
  SHOT_AXES,
  LEVEL_SCORE,
  REVISION_CAP,
  MAX_REVISION_CHARS,
} from "../_cut-shared.ts";

type PieceRow = {
  id: string;
  slug: string;
  prompt_raw: string;
  title: string | null;
  aspect_ratio: string;
  resolution: string;
  target_seconds: number;
  status: string;
  current_version: number;
  accepted_version: number | null;
  revision_round: number;
  final_key: string | null;
  final_sheet_key: string | null;
  seam_sheet_key: string | null;
  final_score: number | null;
  judge_json: string | null;
  visible: number;
  error_log: string | null;
  cost_usd: number;
  created_at: string;
  completed_at: string | null;
};

type ShotRow = {
  shot_id: string;
  attempt: number;
  shot_order: number;
  status: string;
  decision: string | null;
  prompt: string | null;
  conditioning_json: string | null;
  cached_from: string | null;
  video_key: string | null;
  sheet_key: string | null;
  frame_keys_json: string | null;
  judge_json: string | null;
  score: number | null;
  failure_reason: string | null;
  cost_usd: number;
  gen_latency_ms: number | null;
};

// Static subpages live under /cut/ as Astro output, and the studio lives at
// /cut/draft/<id>. Functions run before static assets, so reserved single-
// segment paths must fall through to ctx.next().
const RESERVED_PATHS = new Set(["learn", "draft"]);

export const onRequestGet: PagesFunction<CutEnv> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const slug = url.pathname.replace(/^\/cut\//, "").replace(/\/+$/, "");
  if (RESERVED_PATHS.has(slug)) return ctx.next();
  if (!slug || slug.length > 96 || !/^[a-z0-9-]+$/.test(slug)) {
    return notFound("That address doesn't look like a cut.");
  }

  const piece = await ctx.env.DB.prepare(
    `SELECT id, slug, prompt_raw, title, aspect_ratio, resolution,
            target_seconds, status, current_version, accepted_version,
            revision_round, final_key, final_sheet_key, seam_sheet_key,
            final_score, judge_json, visible, error_log, cost_usd,
            created_at, completed_at
       FROM cut_pieces WHERE slug = ? LIMIT 1`,
  )
    .bind(slug)
    .first<PieceRow>();

  // No matching piece: explicit 404. ctx.next() would hit the Pages SPA
  // fallback (200 + homepage) because the Astro build ships no 404.html.
  if (!piece || !piece.visible) return notFound("No cut at this address.");

  // Still in flight: the draft studio owns the live view.
  if (piece.status !== "completed" && piece.status !== "failed") {
    return Response.redirect(
      new URL(`/cut/draft/${piece.id}/`, ctx.request.url).toString(),
      302,
    );
  }

  const origin = url.origin;

  if (piece.status === "failed") {
    return new Response(renderFailed(piece, origin), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const version = piece.accepted_version ?? piece.current_version;

  const docRow = await ctx.env.DB.prepare(
    `SELECT doc FROM cut_compositions WHERE piece_id = ?1 AND version = ?2 LIMIT 1`,
  )
    .bind(piece.id, version)
    .first<{ doc: string }>();
  const doc = parseJson<CompositionDoc>(docRow?.doc ?? null);

  const shots = await ctx.env.DB.prepare(
    `SELECT shot_id, attempt, shot_order, status, decision, prompt,
            conditioning_json, cached_from, video_key, sheet_key,
            frame_keys_json, judge_json, score, failure_reason,
            cost_usd, gen_latency_ms
       FROM cut_shots WHERE piece_id = ?1 AND version = ?2
      ORDER BY shot_order ASC, attempt ASC`,
  )
    .bind(piece.id, version)
    .all<ShotRow>();

  const html = renderPiece(piece, version, doc, shots.results ?? [], origin);
  // The piece is revisable for up to five rounds; serving a cached copy
  // after a re-cut would show the old version, so this page is never cached.
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
};

// ---------- helpers ----------

function parseJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function derivedTitle(piece: PieceRow): string {
  if (piece.title?.trim()) return piece.title.trim();
  const t = piece.prompt_raw.trim().replace(/\s+/g, " ");
  return t.length > 72 ? `${t.slice(0, 69)}...` : t || "Untitled cut";
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function fmtUtc(sqlite: string | null): string {
  if (!sqlite) return "n/a";
  return `${sqlite} UTC`;
}

function wallSeconds(piece: PieceRow): number | null {
  if (!piece.completed_at || !piece.created_at) return null;
  const ms = Date.parse(`${piece.completed_at.replace(" ", "T")}Z`) -
    Date.parse(`${piece.created_at.replace(" ", "T")}Z`);
  return ms > 0 ? Math.round(ms / 1000) : null;
}

function seamClass(cos: number): string {
  if (cos > 0.8) return "ok";
  if (cos >= 0.6) return "warn";
  return "bad";
}

// Pick the row that represents each shot on the accepted version: the
// accepted attempt when present, otherwise the latest attempt.
function liveShotRows(rows: ShotRow[]): Map<string, { row: ShotRow; attempts: number }> {
  const out = new Map<string, { row: ShotRow; attempts: number }>();
  for (const r of rows) {
    const prev = out.get(r.shot_id);
    if (!prev) {
      out.set(r.shot_id, { row: r, attempts: 1 });
      continue;
    }
    prev.attempts += 1;
    const prevAccepted = prev.row.status === "accepted" || prev.row.decision === "accept";
    const thisAccepted = r.status === "accepted" || r.decision === "accept";
    if (thisAccepted || !prevAccepted) prev.row = r;
  }
  return out;
}

function conditioningLabel(shot: CompositionShot): string {
  if (shot.conditioning?.mode === "chain") {
    return `chained from ${shot.conditioning.source_shot}'s last frame`;
  }
  return "fresh start";
}

// ---------- EDL summary strip ----------

function renderEdl(
  doc: CompositionDoc | null,
  live: Map<string, { row: ShotRow; attempts: number }>,
): string {
  if (!doc?.shots?.length) {
    return `<p class="cut-hint">Composition document not recorded for this piece.</p>`;
  }
  const ordered = [...doc.shots].sort((a, b) => a.order - b.order);
  const trAfter = new Map((doc.transitions ?? []).map((t) => [t.after, t]));

  const blocks: string[] = [];
  ordered.forEach((shot, i) => {
    const lr = live.get(shot.id);
    const sheetKey = shot.artifact?.sheet_key ?? lr?.row.sheet_key ?? null;
    const frameKeys = parseJson<string[]>(lr?.row.frame_keys_json ?? null) ?? [];
    const thumb = frameKeys.length
      ? `/i-cut/${frameKeys[0]}`
      : sheetKey
        ? `/i-cut/${sheetKey}`
        : null;
    const score = lr?.row.score;
    const cached = lr?.row.cached_from ?? (shot.artifact?.from_version ? `v${shot.artifact.from_version}` : null);
    blocks.push(`
      <div class="edl-block" role="listitem">
        <div class="edl-thumb">${thumb ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(shot.id)} frame" loading="lazy" decoding="async" />` : ""}</div>
        <div class="edl-block-meta">
          <a class="edl-id mono" href="#shot-${escapeHtml(shot.id)}">${escapeHtml(shot.id)}</a>
          <span class="edl-dur mono">${shot.duration_s}s</span>
          ${typeof score === "number" ? `<span class="edl-score mono">${score}/24</span>` : ""}
        </div>
        ${cached ? `<span class="edl-cache mono">cached ${escapeHtml(cached)}</span>` : ""}
      </div>`);
    if (i < ordered.length - 1) {
      const tr = trAfter.get(shot.id);
      if (tr?.type === "xfade") {
        blocks.push(`
          <div class="edl-tr" data-type="xfade" title="crossfade ${tr.duration}s">
            <span class="edl-tr-wedge" aria-hidden="true"></span>
            <span class="edl-tr-label mono">xf ${tr.duration}s</span>
          </div>`);
      } else {
        blocks.push(`
          <div class="edl-tr" data-type="cut" title="hard cut">
            <span class="edl-tr-bar" aria-hidden="true"></span>
            <span class="edl-tr-label mono">cut</span>
          </div>`);
      }
    }
  });

  const seams = doc.assembly?.seams ?? [];
  const seamRow = seams.length
    ? `<div class="edl-seams" aria-label="Seam quality">
        ${seams
          .map((s) => {
            const tr = trAfter.get(s.after);
            const xf = tr?.type === "xfade" ? ` · xfade ${tr.duration}s` : "";
            return `<span class="edl-seam" data-q="${seamClass(s.dino_cosine)}">
              <span class="edl-seam-dot" aria-hidden="true"></span>
              <span class="mono">after ${escapeHtml(s.after)} · ${s.dino_cosine.toFixed(2)}${xf}</span>
            </span>`;
          })
          .join("")}
        <span class="cut-hint edl-seams-hint">DINOv2 cosine across each cut point: above 0.80 is a clean seam, below 0.60 the join is visible.</span>
      </div>`
    : "";

  return `
    <div class="edl-strip" role="list" aria-label="Edit decision list">${blocks.join("")}</div>
    ${seamRow}`;
}

// ---------- verdict rendering ----------

function levelBar(level: string): string {
  const score = LEVEL_SCORE[level] ?? 0;
  let cells = "";
  for (let i = 1; i <= 4; i++) {
    cells += `<span class="axis-bar-cell" data-on="${i <= score ? "1" : "0"}"></span>`;
  }
  return `<span class="axis-bar" role="img" aria-label="${score} of 4">${cells}</span>`;
}

function renderAxisRows(judge: JudgeVerdict, axes: readonly string[]): string {
  return axes
    .map((axis) => {
      const a = judge.axes?.[axis];
      const level = a?.level ?? "bad";
      return `
      <div class="axis-row" data-level="${escapeHtml(level)}">
        <span class="axis-name">${escapeHtml(axis)}</span>
        <span class="axis-level">${escapeHtml(level)}</span>
        ${levelBar(level)}
        <span class="axis-rationale">${escapeHtml(a?.rationale ?? "")}</span>
      </div>`;
    })
    .join("");
}

function renderFinalVerdict(judge: JudgeVerdict | null, finalScore: number | null): string {
  if (!judge?.axes) {
    return `<p class="cut-hint">No final verdict recorded for this piece.</p>`;
  }
  return `
    <div class="axis-grid">${renderAxisRows(judge, CUT_AXES)}</div>
    ${typeof finalScore === "number" ? `<p class="axis-total mono">total ${finalScore}/28</p>` : ""}
    ${judge.summary ? `<p class="judge-summary">${escapeHtml(judge.summary)}</p>` : ""}`;
}

// ---------- shot sections ----------

function renderShotSections(
  doc: CompositionDoc | null,
  live: Map<string, { row: ShotRow; attempts: number }>,
): string {
  if (!doc?.shots?.length) return "";
  const ordered = [...doc.shots].sort((a, b) => a.order - b.order);
  return ordered
    .map((shot, i) => {
      const lr = live.get(shot.id);
      const row = lr?.row ?? null;
      const judge = parseJson<JudgeVerdict>(row?.judge_json ?? null);
      const videoKey = shot.artifact?.video_key ?? row?.video_key ?? null;
      const frameKeys = parseJson<string[]>(row?.frame_keys_json ?? null) ?? [];
      const poster = frameKeys.length
        ? `/i-cut/${frameKeys[0]}`
        : shot.artifact?.sheet_key
          ? `/i-cut/${shot.artifact.sheet_key}`
          : undefined;
      const cached = row?.cached_from ?? (shot.artifact?.from_version ? `v${shot.artifact.from_version}` : null);
      return `
      <div class="shot-card" id="shot-${escapeHtml(shot.id)}">
        <div class="shot-card-head">
          <span class="shot-card-title">Shot ${i + 1} <span class="mono shot-card-id">${escapeHtml(shot.id)}</span></span>
          ${typeof row?.score === "number" ? `<span class="shot-card-score mono">${row.score}/24</span>` : ""}
          <span class="shot-card-meta mono">${lr?.attempts ?? 1} attempt${(lr?.attempts ?? 1) === 1 ? "" : "s"} · ${escapeHtml(conditioningLabel(shot))}${cached ? ` · cached from ${escapeHtml(cached)}` : ""}</span>
        </div>
        <p class="shot-card-prompt">${escapeHtml(row?.prompt ?? shot.prompt)}</p>
        ${videoKey ? `<video class="shot-card-video" src="/v-cut/${escapeHtml(videoKey)}" ${poster ? `poster="${escapeHtml(poster)}"` : ""} controls preload="none" playsinline></video>` : ""}
        ${judge?.summary ? `<p class="shot-card-summary">${escapeHtml(judge.summary)}</p>` : ""}
        ${
          judge?.axes
            ? `<details class="shot-card-details">
                 <summary>Per-axis rationale</summary>
                 <div class="axis-grid">${renderAxisRows(judge, SHOT_AXES)}</div>
               </details>`
            : ""
        }
      </div>`;
    })
    .join("");
}

// ---------- revision rail ----------

function renderRail(piece: PieceRow): string {
  const used = piece.revision_round;
  const open = used < REVISION_CAP;
  return `
    <section class="cut-rail" id="cut-rail" aria-label="Revisions">
      <h2 class="reader-h2">Direct the next cut</h2>
      <p class="cut-rail-count mono" id="cut-rev-count">${used} of ${REVISION_CAP} revisions used</p>
      <p class="cut-hint">Give the director a note: reorder shots, change a transition, retake a shot
        with a new idea, or shift the whole style. Deterministic edits re-assemble for free;
        generative ones regenerate only the touched shots.</p>
      <div class="cut-chat-log" id="cut-chat-log" aria-live="polite"></div>
      ${
        open
          ? `<div class="cut-chat-form" id="cut-chat-form">
               <textarea id="cut-chat-input" maxlength="${MAX_REVISION_CHARS}" rows="3"
                 placeholder="Swap shots 2 and 3, and make the last cut a slow crossfade."></textarea>
               <button id="cut-chat-send" type="button">Send note</button>
             </div>
             <p class="cut-recut mono" id="cut-recut-line" hidden>
               <span class="cut-recut-dot" aria-hidden="true"></span>
               Re-cutting. The piece is back on the bench; this page reloads when it settles.
             </p>`
          : `<p class="cut-rail-closed">All ${REVISION_CAP} revision rounds are used. This cut is final.</p>`
      }
    </section>`;
}

function railScript(piece: PieceRow): string {
  const cfg = JSON.stringify({
    id: piece.id,
    round: piece.revision_round,
    cap: REVISION_CAP,
    maxChars: MAX_REVISION_CHARS,
  });
  // NOTE: no backslash-n escapes and no nested template literals below; this
  // block is emitted verbatim into an inline <script>.
  return `<script>
(function () {
  var CFG = ${cfg};
  var log = document.getElementById('cut-chat-log');
  var input = document.getElementById('cut-chat-input');
  var sendBtn = document.getElementById('cut-chat-send');
  var countEl = document.getElementById('cut-rev-count');
  var recutEl = document.getElementById('cut-recut-line');
  var formEl = document.getElementById('cut-chat-form');
  var rail = document.getElementById('cut-rail');
  if (!log || !rail) return;
  var busy = false;

  function bubble(kind, text) {
    var row = document.createElement('div');
    row.className = 'cut-bubble-row';
    row.setAttribute('data-kind', kind);
    var b = document.createElement('div');
    b.className = 'cut-bubble';
    var tag = document.createElement('span');
    tag.className = 'cut-bubble-tag';
    tag.textContent = kind === 'user' ? 'you' : (kind === 'assistant' ? 'director' : 'error');
    var body = document.createElement('p');
    body.className = 'cut-bubble-text';
    body.textContent = text;
    b.appendChild(tag);
    b.appendChild(body);
    row.appendChild(b);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function setBusy(on) {
    busy = on;
    if (input) input.disabled = on;
    if (sendBtn) sendBtn.disabled = on;
  }

  function setRound(n) {
    if (typeof n === 'number') CFG.round = n;
    if (countEl) countEl.textContent = CFG.round + ' of ' + CFG.cap + ' revisions used';
  }

  function closeRail(note) {
    if (formEl) formEl.remove();
    if (recutEl) recutEl.hidden = true;
    var p = document.createElement('p');
    p.className = 'cut-rail-closed';
    p.textContent = note;
    rail.appendChild(p);
  }

  function pollUntilSettled() {
    fetch('/api/cut/status/' + CFG.id, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s && (s.status === 'completed' || s.status === 'failed')) {
          location.reload();
        } else {
          setTimeout(pollUntilSettled, 4000);
        }
      })
      .catch(function () { setTimeout(pollUntilSettled, 4000); });
  }

  function send() {
    if (busy || !input) return;
    var msg = input.value.trim();
    if (!msg) return;
    if (msg.length > CFG.maxChars) msg = msg.slice(0, CFG.maxChars);
    bubble('user', msg);
    input.value = '';
    setBusy(true);
    fetch('/api/cut/revise/' + CFG.id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    })
      .then(function (r) {
        return r.json()
          .then(function (j) { return { http: r.status, body: j }; })
          .catch(function () { return { http: r.status, body: null }; });
      })
      .then(function (res) {
        var body = res.body || {};
        if (res.http === 200 && body.ok) {
          if (typeof body.revision_round === 'number') setRound(body.revision_round);
          bubble('assistant', body.reply || 'Noted.');
          var ops = body.ops || [];
          if (ops.length) {
            if (recutEl) recutEl.hidden = false;
            pollUntilSettled();
            return;
          }
          setBusy(false);
          if (CFG.round >= CFG.cap) {
            closeRail('All ' + CFG.cap + ' revision rounds are used. This cut is final.');
          }
          return;
        }
        var code = body && body.error ? body.error.code : '';
        if (res.http === 409 && code === 'revision_exhausted') {
          bubble('error', 'No revision rounds left. This cut is final.');
          setBusy(false);
          closeRail('All ' + CFG.cap + ' revision rounds are used. This cut is final.');
          return;
        }
        if (res.http === 409) {
          bubble('error', 'The piece is not taking notes right now; a revision may already be running. Give it a moment and reload.');
          setBusy(false);
          return;
        }
        if (res.http === 502) {
          bubble('error', 'The director is unreachable right now. Your note was not applied; try again shortly.');
          setBusy(false);
          return;
        }
        var detail = body && body.error && body.error.message ? body.error.message : 'That note could not be processed.';
        bubble('error', detail);
        setBusy(false);
      })
      .catch(function () {
        bubble('error', 'Network problem; the note was not delivered. Try again.');
        setBusy(false);
      });
  }

  if (sendBtn) sendBtn.addEventListener('click', send);
  if (input) {
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        send();
      }
    });
  }
  setRound(CFG.round);
})();
</script>`;
}

// ---------- page assembly ----------

function renderPiece(
  piece: PieceRow,
  version: number,
  doc: CompositionDoc | null,
  shotRows: ShotRow[],
  origin: string,
): string {
  const title = derivedTitle(piece);
  const live = liveShotRows(shotRows);
  const judge = parseJson<JudgeVerdict>(piece.judge_json);
  const videoUrl = piece.final_key ? `/v-cut/${piece.final_key}` : null;
  const sheetUrl = piece.final_sheet_key ? `/i-cut/${piece.final_sheet_key}` : null;
  const duration = doc?.assembly?.duration_s ?? piece.target_seconds;
  const wall = wallSeconds(piece);
  const shotCount = doc?.shots?.length ?? live.size;

  const jsonLd = videoUrl
    ? {
        "@context": "https://schema.org",
        "@type": "VideoObject",
        name: title,
        description: piece.prompt_raw.slice(0, 300),
        contentUrl: `${origin}${videoUrl}`,
        thumbnailUrl: sheetUrl ? `${origin}${sheetUrl}` : undefined,
        uploadDate: piece.completed_at ? `${piece.completed_at.replace(" ", "T")}Z` : undefined,
        duration: `PT${Math.round(duration)}S`,
        author: "Truffle",
      }
    : null;

  return renderShell({
    title: `${title} · Cut`,
    canonical: `${origin}/cut/${piece.slug}/`,
    description: `${piece.prompt_raw.slice(0, 150)} — a ${shotCount}-shot cut directed, stitched, and judged by an agent.`,
    ogImage: sheetUrl ? `${origin}${sheetUrl}` : null,
    ogVideo: videoUrl ? `${origin}${videoUrl}` : null,
    jsonLd,
    bodyHtml: `
      <main class="reader-page">
        <header class="reader-head">
          <p class="reader-eyebrow"><a href="/cut/">Cut</a></p>
          <h1 class="reader-title">${escapeHtml(title)}</h1>
          <p class="reader-meta">
            ${typeof piece.final_score === "number" ? `<span class="score-badge">judged ${piece.final_score}/28</span><span class="reader-dot">·</span>` : ""}
            <span class="mono">${shotCount} shots / ${Math.round(duration)}s / ${escapeHtml(piece.resolution)} / ${escapeHtml(piece.aspect_ratio)}</span>
            <span class="reader-dot">·</span>
            <span class="mono">v${version}</span>
            ${piece.revision_round > 0 ? `<span class="reader-dot">·</span><span class="mono">${piece.revision_round} revision${piece.revision_round === 1 ? "" : "s"}</span>` : ""}
          </p>
        </header>

        ${
          videoUrl
            ? `<section class="cut-player-wrap" aria-label="Video">
                 <video class="cut-player" src="${escapeHtml(videoUrl)}" ${sheetUrl ? `poster="${escapeHtml(sheetUrl)}"` : ""} controls loop playsinline preload="metadata"></video>
               </section>`
            : ""
        }

        <section class="reader-detail-block">
          <h2 class="reader-h2">The prompt</h2>
          <p class="reader-body">${escapeHtml(piece.prompt_raw)}</p>
        </section>

        <section aria-label="Edit decision list">
          <h2 class="reader-h2">The cut, shot by shot</h2>
          <p class="cut-hint">The timeline the agent assembled: each block is one five-second shot,
            each marker between blocks is the transition it chose, and the dots below score how
            cleanly the seams hold across cut points.</p>
          ${renderEdl(doc, live)}
        </section>

        <section aria-label="Shots">
          ${renderShotSections(doc, live)}
        </section>

        <section aria-label="Final verdict">
          <h2 class="reader-h2">The final verdict</h2>
          <p class="cut-hint">After stitching, a judge scores the whole piece on seven axes; the
            seventh, continuity, only exists for multi-shot work: does it hold together as one film.</p>
          ${renderFinalVerdict(judge, piece.final_score)}
        </section>

        <section class="cut-facts" aria-label="Production facts">
          <h2 class="reader-h2">Production facts</h2>
          <div class="facts-grid">
            <div class="fact"><span class="fact-k">Total cost</span><span class="fact-v mono">${fmtUsd(piece.cost_usd)}</span></div>
            <div class="fact"><span class="fact-k">Runtime</span><span class="fact-v mono">${Math.round(duration)}s</span></div>
            ${wall !== null ? `<div class="fact"><span class="fact-k">Wall time</span><span class="fact-v mono">${wall}s</span></div>` : ""}
            <div class="fact"><span class="fact-k">Started</span><span class="fact-v mono">${escapeHtml(fmtUtc(piece.created_at))}</span></div>
            <div class="fact"><span class="fact-k">Completed</span><span class="fact-v mono">${escapeHtml(fmtUtc(piece.completed_at))}</span></div>
          </div>
        </section>

        ${renderRail(piece)}

        <section class="cut-cta-row">
          <a class="cut-btn cut-btn-primary" href="/cut/">Make your own cut</a>
          <a class="cut-btn" href="/cut/learn/">How the direction works</a>
        </section>
      </main>
      ${railScript(piece)}
    `,
  });
}

function renderFailed(piece: PieceRow, origin: string): string {
  const title = derivedTitle(piece);
  return renderShell({
    title: `${title} · Cut`,
    canonical: `${origin}/cut/${piece.slug}/`,
    description: "This cut did not survive production.",
    ogImage: null,
    ogVideo: null,
    jsonLd: null,
    bodyHtml: `
      <main class="reader-page">
        <header class="reader-head">
          <p class="reader-eyebrow"><a href="/cut/">Cut</a></p>
          <h1 class="reader-title">${escapeHtml(title)}</h1>
        </header>
        <section class="cut-failed-panel">
          <p class="cut-failed-label mono">production failed</p>
          <p class="reader-body">This cut did not make it through production. The prompt was:</p>
          <p class="reader-body cut-failed-prompt">${escapeHtml(piece.prompt_raw)}</p>
          ${piece.error_log ? `<p class="cut-hint">${escapeHtml(piece.error_log.slice(0, 400))}</p>` : ""}
        </section>
        <section class="cut-cta-row">
          <a class="cut-btn cut-btn-primary" href="/cut/">Try another cut</a>
        </section>
      </main>
    `,
  });
}

function notFound(detail: string): Response {
  const html = renderShell({
    title: "Cut · not found",
    canonical: "https://truffleagent.com/cut/",
    description: "This cut is not available.",
    ogImage: null,
    ogVideo: null,
    jsonLd: null,
    bodyHtml: `
      <main class="reader-page">
        <header class="reader-head">
          <p class="reader-eyebrow"><a href="/cut/">Cut</a></p>
          <h1 class="reader-title">Nothing here.</h1>
        </header>
        <p class="reader-body">${escapeHtml(detail)}</p>
        <section class="cut-cta-row">
          <a class="cut-btn cut-btn-primary" href="/cut/">Open the cutting room</a>
        </section>
      </main>
    `,
  });
  return new Response(html, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
  });
}

// ---------- shell ----------

type ShellOpts = {
  title: string;
  canonical: string;
  description: string;
  ogImage: string | null;
  ogVideo: string | null;
  bodyHtml: string;
  jsonLd: Record<string, unknown> | null;
};

function renderShell(opts: ShellOpts): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="#10141b" />
  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${escapeHtml(opts.description)}" />
  <link rel="canonical" href="${escapeHtml(opts.canonical)}" />
  <meta property="og:title" content="${escapeHtml(opts.title)}" />
  <meta property="og:description" content="${escapeHtml(opts.description)}" />
  <meta property="og:type" content="video.other" />
  <meta property="og:url" content="${escapeHtml(opts.canonical)}" />
  ${opts.ogImage ? `<meta property="og:image" content="${escapeHtml(opts.ogImage)}" />` : ""}
  ${
    opts.ogVideo
      ? `<meta property="og:video" content="${escapeHtml(opts.ogVideo)}" />
  <meta property="og:video:type" content="video/mp4" />`
      : ""
  }
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(opts.title)}" />
  <meta name="twitter:description" content="${escapeHtml(opts.description)}" />
  ${opts.ogImage ? `<meta name="twitter:image" content="${escapeHtml(opts.ogImage)}" />` : ""}
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;1,9..144,400;1,9..144,500&family=JetBrains+Mono:wght@400;500&display=swap"
    rel="stylesheet"
  />
  ${opts.jsonLd ? `<script type="application/ld+json">${JSON.stringify(opts.jsonLd).replace(/</g, "\\u003c")}</script>` : ""}
  <style>${PIECE_CSS}</style>
</head>
<body class="cut-piece">
  <nav class="reader-bar" aria-label="Site">
    <a class="reader-bar-brand" href="/">Truffle</a>
    <a class="reader-bar-link" href="/cut/">Cut</a>
    <a class="reader-bar-link" href="/cut/learn/">How the direction works</a>
  </nav>
  ${opts.bodyHtml}
</body>
</html>`;
}

// Filmic identity: deep slate paper, amber highlights on the timeline.
// Typography rhythm inherited from the site design system (Fraunces serif
// titles, Inter body, JetBrains Mono measurements, tabular numerics).
const PIECE_CSS = `
  :root {
    --slate: #10141b; --slate-2: #161c25; --slate-3: #1e2632;
    --ink: #ece7da; --ink-2: #c2bba9; --ink-3: #8b8775;
    --line: #2a3340;
    --amber: #e2a33c; --amber-2: #c4882a;
    --ok: #5cb585; --warn: #d4ad45; --bad: #d97a7a;
    --font-serif: "Fraunces", Georgia, serif;
    --font-sans: "Inter", system-ui, sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--slate); color: var(--ink);
    font-family: var(--font-sans); font-size: 16px; line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .mono { font-family: var(--font-mono); font-size: 0.92em; font-variant-numeric: tabular-nums; }
  a { color: var(--amber); }

  .reader-bar {
    display: flex; align-items: center; gap: 20px;
    padding: 16px 24px; border-bottom: 1px solid var(--line); background: var(--slate);
  }
  .reader-bar a { color: var(--ink); text-decoration: none; font-size: 14px; }
  .reader-bar-brand { font-family: var(--font-serif); font-size: 18px; font-weight: 500; }
  .reader-bar-link {
    color: var(--ink-3) !important; font-family: var(--font-mono);
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em;
  }
  .reader-bar-link:hover { color: var(--ink) !important; }

  .reader-page { max-width: 1000px; margin: 0 auto; padding: 48px 24px 96px; }
  .reader-eyebrow {
    margin: 0 0 12px; font-family: var(--font-mono); font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.14em;
  }
  .reader-eyebrow a { color: var(--ink-3); text-decoration: none; }
  .reader-eyebrow a:hover { color: var(--amber); }
  .reader-title {
    font-family: var(--font-serif); font-weight: 400;
    font-size: clamp(26px, 4vw, 42px); line-height: 1.12; letter-spacing: -0.01em; margin: 0 0 14px;
  }
  .reader-meta {
    font-family: var(--font-mono); font-size: 12px; color: var(--ink-3);
    margin: 0 0 28px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px;
    font-variant-numeric: tabular-nums;
  }
  .reader-dot { margin: 0 4px; }
  .reader-h2 { font-family: var(--font-serif); font-weight: 400; font-size: 24px; margin: 44px 0 12px; }
  .reader-body { color: var(--ink-2); font-size: 14.5px; max-width: 70ch; }
  .reader-detail-block { margin-bottom: 8px; }
  .cut-hint { color: var(--ink-3); font-size: 13.5px; max-width: 66ch; margin: 0 0 16px; }
  .cut-hint a { color: var(--amber); }
  .score-badge {
    display: inline-block; padding: 2px 10px; border-radius: 999px;
    background: color-mix(in oklab, var(--amber) 14%, var(--slate-2));
    border: 1px solid color-mix(in oklab, var(--amber) 50%, var(--line));
    color: var(--amber); font-weight: 600;
  }

  .cut-player-wrap { margin: 0 0 8px; }
  .cut-player {
    width: 100%; border-radius: 14px; border: 1px solid var(--line);
    background: #000; display: block;
  }

  /* EDL strip: read like an NLE timeline */
  .edl-strip {
    display: flex; align-items: stretch; gap: 0;
    border: 1px solid var(--line); border-radius: 12px;
    background: var(--slate-2); padding: 14px 14px 12px; overflow-x: auto;
  }
  .edl-block {
    flex: 1 1 0; min-width: 96px; position: relative;
    border-top: 3px solid var(--amber); background: var(--slate-3);
    border-radius: 6px; padding: 8px 10px 8px; margin: 0 2px;
  }
  .edl-thumb {
    width: 100%; aspect-ratio: 16 / 9; border-radius: 4px; overflow: hidden;
    background: #000; margin-bottom: 8px;
  }
  .edl-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .edl-block-meta {
    display: flex; align-items: baseline; gap: 8px;
    font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums;
  }
  .edl-id { color: var(--amber); text-decoration: none; font-weight: 500; }
  .edl-id:hover { text-decoration: underline; }
  .edl-score { margin-left: auto; color: var(--ink-2); }
  .edl-cache {
    position: absolute; top: 8px; right: 8px;
    font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em;
    background: color-mix(in oklab, var(--ok) 18%, var(--slate-3));
    border: 1px solid color-mix(in oklab, var(--ok) 45%, var(--line));
    color: var(--ok); border-radius: 999px; padding: 1px 7px;
  }
  .edl-tr {
    flex: 0 0 auto; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 4px; padding: 0 4px;
  }
  .edl-tr-bar { width: 2px; height: 42px; background: var(--ink-3); display: block; }
  .edl-tr-wedge {
    width: 18px; height: 42px; display: block;
    background: linear-gradient(105deg, var(--amber) 0%, transparent 55%),
                linear-gradient(285deg, var(--amber-2) 0%, transparent 55%);
    opacity: 0.85; border-radius: 2px;
  }
  .edl-tr-label { font-size: 9.5px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.06em; }

  .edl-seams { display: flex; flex-wrap: wrap; gap: 14px; align-items: baseline; margin: 12px 2px 0; }
  .edl-seam { display: inline-flex; align-items: baseline; gap: 7px; font-size: 12px; color: var(--ink-2); }
  .edl-seam-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; transform: translateY(1px); }
  .edl-seam[data-q="ok"] .edl-seam-dot { background: var(--ok); }
  .edl-seam[data-q="warn"] .edl-seam-dot { background: var(--warn); }
  .edl-seam[data-q="bad"] .edl-seam-dot { background: var(--bad); }
  .edl-seams-hint { flex-basis: 100%; margin: 4px 0 0; }

  /* shot cards */
  .shot-card {
    border: 1px solid var(--line); border-left: 3px solid var(--amber);
    border-radius: 10px; padding: 16px 20px; background: var(--slate-2); margin-bottom: 14px;
  }
  .shot-card-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin-bottom: 6px; }
  .shot-card-title { font-family: var(--font-serif); font-size: 18px; }
  .shot-card-id { color: var(--ink-3); font-size: 12px; }
  .shot-card-score {
    font-size: 12px; font-weight: 600; color: var(--amber);
    border: 1px solid color-mix(in oklab, var(--amber) 45%, var(--line));
    border-radius: 999px; padding: 1px 9px;
  }
  .shot-card-meta { font-size: 11.5px; color: var(--ink-3); }
  .shot-card-prompt { margin: 4px 0 10px; font-size: 13.5px; color: var(--ink-2); max-width: 72ch; }
  .shot-card-video { width: min(480px, 100%); border-radius: 10px; border: 1px solid var(--line); display: block; background: #000; margin-bottom: 10px; }
  .shot-card-summary { margin: 0 0 8px; font-size: 13.5px; color: var(--ink-2); font-style: italic; max-width: 70ch; }
  .shot-card-details summary {
    cursor: pointer; font-family: var(--font-mono); font-size: 11.5px;
    text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3);
  }
  .shot-card-details summary:hover { color: var(--amber); }
  .shot-card-details[open] summary { margin-bottom: 10px; }

  /* verdict axes */
  .axis-grid { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .axis-row {
    display: grid; grid-template-columns: 110px 88px 76px 1fr; gap: 12px;
    padding: 11px 16px; border-bottom: 1px solid var(--line); background: var(--slate-2);
    font-size: 13px; align-items: center;
  }
  .axis-row:last-child { border-bottom: none; }
  .axis-name { font-family: var(--font-mono); font-size: 12px; color: var(--ink-2); }
  .axis-level { font-family: var(--font-mono); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
  .axis-row[data-level="excellent"] .axis-level { color: var(--ok); }
  .axis-row[data-level="good"] .axis-level { color: var(--ok); opacity: 0.85; }
  .axis-row[data-level="fair"] .axis-level { color: var(--warn); }
  .axis-row[data-level="poor"] .axis-level, .axis-row[data-level="bad"] .axis-level { color: var(--bad); }
  .axis-bar { display: inline-flex; gap: 3px; }
  .axis-bar-cell { width: 14px; height: 7px; border-radius: 2px; background: var(--slate-3); border: 1px solid var(--line); }
  .axis-bar-cell[data-on="1"] { background: var(--amber); border-color: var(--amber-2); }
  .axis-rationale { color: var(--ink-3); font-size: 12.5px; line-height: 1.5; }
  @media (max-width: 680px) {
    .axis-row { grid-template-columns: 90px 76px 1fr; }
    .axis-rationale { grid-column: 1 / -1; }
  }
  .axis-total { margin: 12px 0 0; font-size: 13px; color: var(--amber); font-weight: 600; font-variant-numeric: tabular-nums; }
  .judge-summary { margin: 14px 0 0; color: var(--ink-2); font-size: 14px; max-width: 68ch; font-style: italic; }

  /* production facts */
  .facts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .fact {
    border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; background: var(--slate-2);
    display: flex; flex-direction: column; gap: 2px;
  }
  .fact-k {
    font-family: var(--font-mono); font-size: 10.5px; text-transform: uppercase;
    letter-spacing: 0.1em; color: var(--ink-3);
  }
  .fact-v { font-size: 15px; color: var(--ink); font-variant-numeric: tabular-nums; }

  /* revision rail */
  .cut-rail {
    margin-top: 48px; border: 1px solid var(--line); border-radius: 14px;
    background: var(--slate-2); padding: 24px 24px 20px;
  }
  .cut-rail .reader-h2 { margin-top: 0; }
  .cut-rail-count { font-size: 12px; color: var(--amber); margin: 0 0 10px; font-variant-numeric: tabular-nums; }
  .cut-rail-closed { color: var(--ink-3); font-size: 13.5px; margin: 8px 0 0; font-style: italic; }
  .cut-chat-log { display: flex; flex-direction: column; gap: 10px; max-height: 360px; overflow-y: auto; margin: 0 0 14px; }
  .cut-chat-log:empty { display: none; }
  .cut-bubble-row { display: flex; }
  .cut-bubble-row[data-kind="user"] { justify-content: flex-end; }
  .cut-bubble {
    max-width: 78%; border: 1px solid var(--line); border-radius: 12px;
    background: var(--slate-3); padding: 9px 14px;
  }
  .cut-bubble-row[data-kind="user"] .cut-bubble {
    background: color-mix(in oklab, var(--amber) 12%, var(--slate-3));
    border-color: color-mix(in oklab, var(--amber) 35%, var(--line));
  }
  .cut-bubble-row[data-kind="error"] .cut-bubble {
    border-color: color-mix(in oklab, var(--bad) 50%, var(--line));
  }
  .cut-bubble-tag {
    display: block; font-family: var(--font-mono); font-size: 9.5px;
    text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); margin-bottom: 2px;
  }
  .cut-bubble-row[data-kind="error"] .cut-bubble-tag { color: var(--bad); }
  .cut-bubble-text { margin: 0; font-size: 13.5px; color: var(--ink-2); white-space: pre-wrap; }
  .cut-chat-form { display: flex; gap: 10px; align-items: flex-end; }
  .cut-chat-form textarea {
    flex: 1; resize: vertical; min-height: 64px; border-radius: 10px;
    border: 1px solid var(--line); background: var(--slate); color: var(--ink);
    font-family: var(--font-sans); font-size: 14px; padding: 10px 14px; line-height: 1.5;
  }
  .cut-chat-form textarea:focus { outline: none; border-color: var(--amber); }
  .cut-chat-form textarea:disabled, .cut-chat-form button:disabled { opacity: 0.5; cursor: not-allowed; }
  .cut-chat-form button {
    border: 1px solid var(--amber); background: var(--amber); color: #1a1410;
    font-family: var(--font-sans); font-size: 14px; font-weight: 600;
    border-radius: 999px; padding: 10px 22px; cursor: pointer;
  }
  .cut-chat-form button:hover:not(:disabled) { background: var(--amber-2); border-color: var(--amber-2); }
  .cut-recut { display: flex; align-items: center; gap: 9px; margin: 12px 0 0; font-size: 12px; color: var(--amber); }
  .cut-recut-dot {
    width: 9px; height: 9px; border-radius: 50%; background: var(--amber);
    animation: cut-pulse 1.4s ease-in-out infinite;
  }
  @keyframes cut-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

  /* failed panel */
  .cut-failed-panel {
    border: 1px solid color-mix(in oklab, var(--bad) 45%, var(--line));
    border-radius: 12px; background: var(--slate-2); padding: 20px 24px;
  }
  .cut-failed-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--bad); margin: 0 0 10px;
  }
  .cut-failed-prompt { font-style: italic; }

  .cut-cta-row { margin-top: 48px; display: flex; gap: 12px; flex-wrap: wrap; }
  .cut-btn {
    display: inline-block; padding: 10px 22px; border-radius: 999px;
    font-size: 14px; text-decoration: none; border: 1px solid var(--line); color: var(--ink);
  }
  .cut-btn:hover { border-color: var(--ink-3); }
  .cut-btn-primary { background: var(--amber); border-color: var(--amber); color: #1a1410; font-weight: 600; }
  .cut-btn-primary:hover { background: var(--amber-2); border-color: var(--amber-2); }
`;
