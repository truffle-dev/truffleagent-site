// GET /take/<slug>/
// Finished piece page: the clip plus the full eval receipt.
// The receipt is the product: L0 gate results, L1 lane traces with
// sparklines, the judge's six-axis verdict with rationales, the contact
// sheet the judge actually read, and the attempt history with costs.
// Redirects to the draft view if the piece is still in flight.

import {
  type TakeEnv,
  type JudgeVerdict,
  LEVEL_SCORE,
  verdictScore,
} from "../_take-shared.ts";

type PieceRow = {
  id: string;
  slug: string;
  prompt_raw: string;
  prompt_enhanced: string | null;
  aspect_ratio: string;
  resolution: string;
  duration: string;
  status: string;
  current_attempt: number;
  max_attempts: number;
  accepted_attempt: number | null;
  video_key: string | null;
  sheet_key: string | null;
  visible: number;
  cost_usd: number;
  created_at: string;
  completed_at: string | null;
};

type AttemptRow = {
  attempt_index: number;
  compose_json: string | null;
  status: string;
  video_key: string | null;
  sheet_key: string | null;
  frame_keys_json: string | null;
  eval_json: string | null;
  judge_json: string | null;
  decision: string | null;
  failure_reason: string | null;
  cost_usd: number;
  gen_latency_ms: number | null;
  eval_latency_ms: number | null;
};

type EvalResults = {
  probe?: Record<string, unknown>;
  gates?: { name: string; passed: boolean; value?: string; detail?: string }[];
  gates_passed?: boolean;
  metrics?: Record<
    string,
    { values?: number[]; summary?: { mean: number; min: number; max: number; std: number } }
  >;
  elapsed_s?: number;
};

const RESERVED_PATHS = new Set(["learn"]);

export const onRequestGet: PagesFunction<TakeEnv> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const slug = url.pathname.replace(/^\/take\//, "").replace(/\/+$/, "");
  // Static subpages live under /take/ as Astro output; Functions run before
  // static assets, so reserved paths must fall through to ctx.next().
  if (RESERVED_PATHS.has(slug)) return ctx.next();
  if (!slug || slug.length > 96 || !/^[a-z0-9-]+$/.test(slug)) {
    return notFound("That address doesn't look like a take.");
  }

  const piece = await ctx.env.DB.prepare(
    `SELECT id, slug, prompt_raw, prompt_enhanced, aspect_ratio, resolution,
            duration, status, current_attempt, max_attempts, accepted_attempt,
            video_key, sheet_key, visible, cost_usd, created_at, completed_at
       FROM take_pieces WHERE slug = ? LIMIT 1`,
  )
    .bind(slug)
    .first<PieceRow>();

  if (!piece || !piece.visible) return notFound("No take at this address.");

  if (piece.status !== "completed") {
    return Response.redirect(
      new URL(`/take/draft/${piece.id}/`, ctx.request.url).toString(),
      302,
    );
  }

  const attempts = await ctx.env.DB.prepare(
    `SELECT attempt_index, compose_json, status, video_key, sheet_key,
            frame_keys_json, eval_json, judge_json, decision, failure_reason,
            cost_usd, gen_latency_ms, eval_latency_ms
       FROM take_attempts WHERE piece_id = ? ORDER BY attempt_index ASC`,
  )
    .bind(piece.id)
    .all<AttemptRow>();

  const html = renderPiece(piece, attempts.results ?? []);
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=3600",
    },
  });
};

function notFound(detail: string): Response {
  const html = renderShell({
    title: "Take · not found",
    canonical: "https://truffleagent.com/take/",
    description: "This take is not available.",
    bodyHtml: `
      <main class="reader-page">
        <p class="reader-eyebrow"><a href="/take/">Back to Take</a></p>
        <h1 class="reader-title">Nothing here.</h1>
        <p class="reader-lead">${escapeHtml(detail)}</p>
        <p><a class="take-btn take-btn-primary" href="/take/">Open the studio</a></p>
      </main>`,
    jsonLd: null,
  });
  return new Response(html, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
  });
}

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

const LANE_META: Record<string, { label: string; what: string; plain: string; fmt: number }> = {
  flicker: {
    label: "Flicker",
    what: "mean abs luma diff between consecutive frames",
    plain:
      "How much each frame differs from the next, checked on every frame. A high average usually just means a busy scene; sudden spikes far above the average mean strobing.",
    fmt: 2,
  },
  flow: {
    label: "Optical flow",
    what: "Farneback flow magnitude, motion energy per frame pair",
    plain:
      "How far pixels move between frames: one number for how much is actually happening. Under 0.3 is basically a still image; 2 to 8 is normal motion.",
    fmt: 2,
  },
  clipscore: {
    label: "CLIPScore",
    what: "cosine of CLIP ViT-B/32 prompt and frame embeddings",
    plain:
      "How well the frames match what you typed, scored by CLIP. 0.30 and up is well on-prompt; below 0.24 the model probably wandered off.",
    fmt: 3,
  },
  dino_drift: {
    label: "DINO drift",
    what: "DINOv2 cosine of each sampled frame against frame 0",
    plain:
      "Whether the subject stays the same subject, with every frame compared against the first. Watch the min: a single frame below 0.5 means identity broke.",
    fmt: 3,
  },
};

function sparkline(values: number[], w = 220, h = 36): string {
  if (!values || values.length < 2) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const step = w / (values.length - 1);
  const pts = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - 3 - ((v - lo) / span) * (h - 6)).toFixed(1)}`)
    .join(" ");
  return `<svg class="lane-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /></svg>`;
}

function renderGatesTable(ev: EvalResults | null): string {
  const gates = ev?.gates;
  if (!gates?.length) return `<p class="take-hint">Gate results not recorded for this attempt.</p>`;
  return `
    <table class="gate-table">
      <thead><tr><th>Gate</th><th>Result</th><th>Reading</th><th>Check</th></tr></thead>
      <tbody>
        ${gates
          .map(
            (g) => `
          <tr data-pass="${g.passed ? "1" : "0"}">
            <td class="mono">${escapeHtml(g.name.replace(/_/g, " "))}</td>
            <td class="gate-result">${g.passed ? "pass" : "fail"}</td>
            <td class="mono">${escapeHtml(String(g.value ?? ""))}</td>
            <td class="gate-detail">${escapeHtml(String(g.detail ?? ""))}</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

function renderLanes(ev: EvalResults | null): string {
  const metrics = ev?.metrics;
  if (!metrics) return `<p class="take-hint">Lane traces not recorded for this attempt.</p>`;
  return `
    <div class="lane-grid">
      ${Object.entries(LANE_META)
        .map(([key, meta]) => {
          const m = metrics[key];
          if (!m?.summary) return "";
          const s = m.summary;
          return `
          <div class="lane-card">
            <div class="lane-card-head">
              <span class="lane-card-name">${meta.label}</span>
              <span class="lane-card-mean mono">${s.mean.toFixed(meta.fmt)}</span>
            </div>
            ${m.values ? sparkline(m.values) : ""}
            <div class="lane-card-range mono">min ${s.min.toFixed(meta.fmt)} · max ${s.max.toFixed(meta.fmt)} · σ ${s.std.toFixed(meta.fmt)}</div>
            <p class="lane-card-what">${meta.what}</p>
            <p class="lane-card-plain">${meta.plain}</p>
          </div>`;
        })
        .join("")}
    </div>
    <p class="take-hint lane-grid-hint">These bands come from a 14-clip calibration set we ran before launch. <a href="/take/learn/#calibration">See the full thresholds and the clips that set them.</a></p>`;
}

function renderVerdict(judge: JudgeVerdict | null): string {
  if (!judge?.axes) return `<p class="take-hint">No judge verdict recorded for this attempt.</p>`;
  const rows = Object.entries(judge.axes)
    .map(
      ([axis, a]) => `
      <div class="axis-row" data-level="${escapeHtml(a.level ?? "")}">
        <span class="axis-name">${escapeHtml(axis)}</span>
        <span class="axis-level">${escapeHtml(a.level ?? "")}</span>
        <span class="axis-rationale">${escapeHtml(a.rationale ?? "")}</span>
      </div>`,
    )
    .join("");
  return `
    <div class="axis-grid">${rows}</div>
    ${judge.summary ? `<p class="judge-summary">${escapeHtml(judge.summary)}</p>` : ""}`;
}

function fmtMs(ms: number | null): string {
  if (!ms) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function renderPiece(piece: PieceRow, attempts: AttemptRow[]): string {
  const title = derivedTitle(piece.prompt_raw);
  const accepted = attempts.find((a) => a.attempt_index === piece.accepted_attempt) ?? null;
  const ev = accepted ? parseJson<EvalResults>(accepted.eval_json) : null;
  const judge = accepted ? parseJson<JudgeVerdict>(accepted.judge_json) : null;
  const composed = accepted
    ? parseJson<{ prompt?: string; reasoning?: string }>(accepted.compose_json)
    : null;
  const frameKeys = accepted ? (parseJson<string[]>(accepted.frame_keys_json) ?? []) : [];
  const videoUrl = piece.video_key ? `/v-take/${piece.video_key}` : null;
  const sheetUrl = piece.sheet_key ? `/i-take/${piece.sheet_key}` : null;
  const posterUrl = frameKeys.length ? `/i-take/${frameKeys[0]}` : undefined;
  const score = judge ? verdictScore(judge) : null;

  const wallSeconds =
    piece.completed_at && piece.created_at
      ? Math.max(0, (Date.parse(`${piece.completed_at}Z`) - Date.parse(`${piece.created_at}Z`)) / 1000)
      : null;

  const jsonLd = videoUrl
    ? {
        "@context": "https://schema.org",
        "@type": "VideoObject",
        name: title,
        description: piece.prompt_raw.slice(0, 300),
        contentUrl: `https://truffleagent.com${videoUrl}`,
        thumbnailUrl: sheetUrl ? `https://truffleagent.com${sheetUrl}` : undefined,
        uploadDate: piece.completed_at ? `${piece.completed_at.replace(" ", "T")}Z` : undefined,
        author: "Truffle",
      }
    : null;

  const attemptCards = attempts
    .map((a) => {
      const aEv = parseJson<EvalResults>(a.eval_json);
      const aJudge = parseJson<JudgeVerdict>(a.judge_json);
      const aScore = aJudge ? verdictScore(aJudge) : null;
      const isAccepted = a.attempt_index === piece.accepted_attempt;
      const gateFails = (aEv?.gates ?? []).filter((g) => !g.passed).map((g) => g.name);
      const verdictBits: string[] = [];
      if (aJudge?.axes) {
        for (const [axis, ax] of Object.entries(aJudge.axes)) {
          if ((LEVEL_SCORE[ax.level] ?? 5) <= 1) verdictBits.push(`${axis}: ${ax.level}`);
        }
      }
      return `
      <div class="attempt-card" data-accepted="${isAccepted ? "1" : "0"}">
        <div class="attempt-card-head">
          <span class="attempt-card-title">Attempt ${a.attempt_index}</span>
          <span class="attempt-card-badge" data-kind="${isAccepted ? "accept" : a.decision ?? "none"}">
            ${isAccepted ? "accepted" : a.decision === "retake" ? "rejected, retaken" : a.decision === "abort" ? "rejected" : a.status}
          </span>
          ${aScore !== null ? `<span class="attempt-card-score mono">score ${aScore}/24</span>` : ""}
        </div>
        <div class="attempt-card-meta mono">
          gen ${fmtMs(a.gen_latency_ms)}${aEv?.elapsed_s ? ` · eval ${aEv.elapsed_s.toFixed(1)}s` : ""}
        </div>
        ${gateFails.length ? `<p class="attempt-card-why">Failed gates: ${gateFails.map(escapeHtml).join(", ")} (judge skipped, retake issued)</p>` : ""}
        ${!isAccepted && verdictBits.length ? `<p class="attempt-card-why">Judge flagged ${verdictBits.map(escapeHtml).join(", ")}</p>` : ""}
        ${!isAccepted && a.failure_reason ? `<p class="attempt-card-why">${escapeHtml(a.failure_reason.slice(0, 280))}</p>` : ""}
        ${!isAccepted && a.video_key ? `<video class="attempt-card-video" src="/v-take/${escapeHtml(a.video_key)}" controls preload="none" playsinline></video>` : ""}
      </div>`;
    })
    .join("");

  return renderShell({
    title: `${title} · Take`,
    canonical: `https://truffleagent.com/take/${piece.slug}/`,
    description: `${piece.prompt_raw.slice(0, 150)} — generated on Luma ray-3.2 and accepted by a live eval cascade.`,
    jsonLd,
    bodyHtml: `
      <main class="reader-page">
        <header class="reader-head">
          <p class="reader-eyebrow"><a href="/take/">Take</a></p>
          <h1 class="reader-title">${escapeHtml(title)}</h1>
          <p class="reader-meta">
            ${score !== null ? `<span class="score-badge">eval ${score}/24</span><span class="reader-dot">·</span>` : ""}
            <span class="mono">${escapeHtml(piece.resolution)} / ${escapeHtml(piece.duration)} / ${escapeHtml(piece.aspect_ratio)}</span>
            <span class="reader-dot">·</span>
            <span class="mono">${attempts.length} attempt${attempts.length === 1 ? "" : "s"}</span>
            ${wallSeconds !== null ? `<span class="reader-dot">·</span><span class="mono">${Math.round(wallSeconds)}s wall</span>` : ""}
          </p>
        </header>

        ${
          videoUrl
            ? `<section class="take-player-wrap" aria-label="Video">
                 <video class="take-player" src="${escapeHtml(videoUrl)}" ${posterUrl ? `poster="${escapeHtml(posterUrl)}"` : ""} controls loop playsinline preload="metadata"></video>
               </section>`
            : ""
        }

        <section class="reader-detail">
          <div class="reader-detail-block">
            <h2 class="reader-h2">The prompt</h2>
            <p class="reader-body">${escapeHtml(piece.prompt_raw)}</p>
          </div>
          ${
            composed?.prompt
              ? `<div class="reader-detail-block">
                   <h2 class="reader-h2">What the agent wrote</h2>
                   <p class="reader-body">${escapeHtml(composed.prompt)}</p>
                   ${composed.reasoning ? `<p class="take-hint">Why this framing: ${escapeHtml(composed.reasoning)}</p>` : ""}
                 </div>`
              : ""
          }
        </section>

        <section aria-label="Eval receipt">
          <h2 class="reader-h2">The eval receipt</h2>
          <p class="take-hint">
            Every Take clip ships with the measurements that admitted it. Deterministic
            gates and CV lanes run first; the VLM judge only rules on what those lanes
            cannot measure, and it must justify each level before naming it.
            <a href="/take/learn/">How the cascade works.</a>
          </p>

          <h3 class="receipt-h">L0 · Deterministic gates</h3>
          ${renderGatesTable(ev)}

          <h3 class="receipt-h">L1 · CV lanes</h3>
          ${renderLanes(ev)}

          <h3 class="receipt-h">L2 · Judge verdict</h3>
          ${renderVerdict(judge)}

          ${
            sheetUrl
              ? `<h3 class="receipt-h">What the judge saw</h3>
                 <p class="take-hint">The timestamped contact sheet, exactly as handed to the judge. ffmpeg pulled eight evenly spaced frames from the clip, stamped each with its timestamp, and tiled them into this one grid; it is the only image the judge reads. <a href="/take/learn/#judge">Why a grid beats a video.</a></p>
                 <a href="${escapeHtml(sheetUrl)}" target="_blank" rel="noopener">
                   <img class="take-sheet" src="${escapeHtml(sheetUrl)}" alt="Timestamped contact sheet" loading="lazy" decoding="async" />
                 </a>`
              : ""
          }
        </section>

        ${
          attempts.length
            ? `<section aria-label="Attempt history">
                 <h2 class="reader-h2">Attempt history</h2>
                 <div class="attempt-cards">${attemptCards}</div>
               </section>`
            : ""
        }

        <section class="take-cta-row">
          <a class="take-btn take-btn-primary" href="/take/">Make your own take</a>
          <a class="take-btn" href="/take/learn/">Read how the eval works</a>
        </section>
      </main>
    `,
  });
}

function derivedTitle(prompt: string): string {
  const t = prompt.trim().replace(/\s+/g, " ");
  return t.length > 72 ? `${t.slice(0, 69)}...` : t || "Untitled take";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type ShellOpts = {
  title: string;
  canonical: string;
  description: string;
  bodyHtml: string;
  jsonLd: Record<string, unknown> | null;
};

function renderShell(opts: ShellOpts): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="color-scheme" content="light dark" />
  <meta name="theme-color" content="#fbfaf5" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#0e0c08" media="(prefers-color-scheme: dark)" />
  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${escapeHtml(opts.description)}" />
  <link rel="canonical" href="${escapeHtml(opts.canonical)}" />
  <meta property="og:title" content="${escapeHtml(opts.title)}" />
  <meta property="og:description" content="${escapeHtml(opts.description)}" />
  <meta property="og:type" content="video.other" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;1,9..144,400;1,9..144,500&family=JetBrains+Mono:wght@400;500&display=swap"
    rel="stylesheet"
  />
  ${opts.jsonLd ? `<script type="application/ld+json">${JSON.stringify(opts.jsonLd)}</script>` : ""}
  <style>${PIECE_CSS}</style>
</head>
<body class="take-piece">
  <nav class="reader-bar" aria-label="Site">
    <a class="reader-bar-brand" href="/">Truffle</a>
    <a class="reader-bar-link" href="/take/">Take</a>
    <a class="reader-bar-link" href="/take/learn/">How the eval works</a>
  </nav>
  ${opts.bodyHtml}
</body>
</html>`;
}

const PIECE_CSS = `
  :root {
    --paper: #fbfaf5; --paper-2: #f4f1e8; --paper-3: #e9e4d4;
    --ink: #1a1612; --ink-2: #3a342b; --ink-3: #736a52;
    --line: #d8d1bd;
    --accent: #2d5fb8; --accent-2: #234c96;
    --ok: #2e7d4f; --warn: #c19018; --bad: #b94c4c;
    --font-serif: "Fraunces", Georgia, serif;
    --font-sans: "Inter", system-ui, sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #0e0c08; --paper-2: #18140e; --paper-3: #221c14;
      --ink: #f4f0e6; --ink-2: #ccc4ad; --ink-3: #998c70;
      --line: #2d2618;
      --accent: #6e96e0; --accent-2: #4d7ccc;
      --ok: #5cb585; --warn: #d4ad45; --bad: #d97a7a;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--paper); color: var(--ink);
    font-family: var(--font-sans); font-size: 16px; line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .mono { font-family: var(--font-mono); font-size: 0.92em; font-variant-numeric: tabular-nums; }
  .reader-bar {
    display: flex; align-items: center; gap: 20px;
    padding: 16px 24px; border-bottom: 1px solid var(--line); background: var(--paper);
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
  .reader-eyebrow a:hover { color: var(--accent); }
  .reader-title {
    font-family: var(--font-serif); font-weight: 400;
    font-size: clamp(26px, 4vw, 42px); line-height: 1.12; letter-spacing: -0.01em; margin: 0 0 14px;
  }
  .reader-meta {
    font-family: var(--font-mono); font-size: 12px; color: var(--ink-3);
    margin: 0 0 28px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px;
  }
  .reader-dot { margin: 0 4px; }
  .reader-lead { color: var(--ink-2); max-width: 60ch; }
  .score-badge {
    display: inline-block; padding: 2px 10px; border-radius: 999px;
    background: color-mix(in oklab, var(--ok) 12%, var(--paper-2));
    border: 1px solid color-mix(in oklab, var(--ok) 45%, var(--line));
    color: var(--ok); font-weight: 600;
  }
  .reader-h2 { font-family: var(--font-serif); font-weight: 400; font-size: 24px; margin: 44px 0 12px; }
  .receipt-h {
    font-family: var(--font-mono); font-size: 12px; font-weight: 500;
    text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink-3);
    margin: 32px 0 12px;
  }
  .take-hint { color: var(--ink-3); font-size: 13.5px; max-width: 66ch; margin: 0 0 16px; }
  .take-hint a { color: var(--accent); }

  .take-player-wrap { margin: 0 0 8px; }
  .take-player {
    width: 100%; border-radius: 14px; border: 1px solid var(--line);
    background: #000; display: block; aspect-ratio: 16 / 9;
  }

  .reader-detail { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 760px) { .reader-detail { grid-template-columns: 1fr; } }
  .reader-body { color: var(--ink-2); font-size: 14.5px; }

  .gate-table {
    width: 100%; border-collapse: collapse; font-size: 13px;
    border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
  }
  .gate-table th {
    text-align: left; font-family: var(--font-mono); font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3);
    font-weight: 500; padding: 10px 14px; background: var(--paper-2);
    border-bottom: 1px solid var(--line);
  }
  .gate-table td { padding: 9px 14px; border-bottom: 1px solid var(--line); vertical-align: baseline; }
  .gate-table tr:last-child td { border-bottom: none; }
  .gate-result { font-family: var(--font-mono); font-size: 12px; font-weight: 600; text-transform: uppercase; }
  tr[data-pass="1"] .gate-result { color: var(--ok); }
  tr[data-pass="0"] .gate-result { color: var(--bad); }
  .gate-detail { color: var(--ink-3); font-size: 12.5px; }
  @media (max-width: 640px) { .gate-detail { display: none; } }

  .lane-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 700px) { .lane-grid { grid-template-columns: 1fr; } }
  .lane-card {
    border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px 14px;
    background: var(--paper-2);
  }
  .lane-card-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .lane-card-name { font-family: var(--font-mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-2); }
  .lane-card-mean { font-size: 18px; font-weight: 600; color: var(--ink); }
  .lane-spark { width: 100%; height: 36px; color: var(--accent); margin-bottom: 6px; }
  .lane-card-range { font-size: 11px; color: var(--ink-3); margin-bottom: 6px; }
  .lane-card-what { margin: 0; font-size: 12px; color: var(--ink-3); line-height: 1.5; }
  .lane-card-plain {
    margin: 8px 0 0; padding-top: 8px; font-size: 12.5px; color: var(--ink-2); line-height: 1.55;
    border-top: 1px solid color-mix(in oklab, var(--line) 60%, transparent);
  }
  .lane-grid-hint { margin-top: 12px; }
  .lane-grid-hint a { color: var(--accent); }

  .axis-grid { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .axis-row {
    display: grid; grid-template-columns: 120px 95px 1fr; gap: 12px;
    padding: 11px 16px; border-bottom: 1px solid var(--line); background: var(--paper-2);
    font-size: 13px; align-items: baseline;
  }
  .axis-row:last-child { border-bottom: none; }
  .axis-name { font-family: var(--font-mono); font-size: 12px; color: var(--ink-2); }
  .axis-level { font-family: var(--font-mono); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
  .axis-row[data-level="excellent"] .axis-level { color: var(--ok); }
  .axis-row[data-level="good"] .axis-level { color: var(--ok); opacity: 0.85; }
  .axis-row[data-level="fair"] .axis-level { color: var(--warn); }
  .axis-row[data-level="poor"] .axis-level, .axis-row[data-level="bad"] .axis-level { color: var(--bad); }
  .axis-rationale { color: var(--ink-3); font-size: 12.5px; line-height: 1.5; }
  @media (max-width: 640px) {
    .axis-row { grid-template-columns: 90px 75px; }
    .axis-rationale { grid-column: 1 / -1; }
  }
  .judge-summary { margin: 14px 0 0; color: var(--ink-2); font-size: 14px; max-width: 68ch; font-style: italic; }

  .take-sheet {
    width: 100%; border-radius: 12px; border: 1px solid var(--line); display: block;
  }

  .attempt-cards { display: flex; flex-direction: column; gap: 12px; }
  .attempt-card {
    border: 1px solid var(--line); border-left-width: 3px; border-radius: 10px;
    padding: 14px 18px; background: var(--paper-2);
  }
  .attempt-card[data-accepted="1"] { border-left-color: var(--ok); }
  .attempt-card[data-accepted="0"] { border-left-color: var(--warn); }
  .attempt-card-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin-bottom: 4px; }
  .attempt-card-title { font-family: var(--font-serif); font-size: 17px; }
  .attempt-card-badge {
    font-family: var(--font-mono); font-size: 10.5px; text-transform: uppercase;
    letter-spacing: 0.08em; padding: 2px 9px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--ink-3);
  }
  .attempt-card-badge[data-kind="accept"] { color: var(--ok); border-color: color-mix(in oklab, var(--ok) 45%, var(--line)); }
  .attempt-card-badge[data-kind="retake"] { color: var(--warn); border-color: color-mix(in oklab, var(--warn) 45%, var(--line)); }
  .attempt-card-badge[data-kind="abort"] { color: var(--bad); border-color: color-mix(in oklab, var(--bad) 45%, var(--line)); }
  .attempt-card-score { font-size: 11.5px; color: var(--ink-3); }
  .attempt-card-meta { font-size: 11.5px; color: var(--ink-3); margin-bottom: 6px; }
  .attempt-card-why { margin: 4px 0 0; font-size: 13px; color: var(--ink-2); max-width: 70ch; }
  .attempt-card-video { width: min(420px, 100%); border-radius: 10px; border: 1px solid var(--line); margin-top: 10px; display: block; background: #000; }

  .take-cta-row { margin-top: 48px; display: flex; gap: 12px; flex-wrap: wrap; }
  .take-btn {
    display: inline-block; padding: 10px 22px; border-radius: 999px;
    font-size: 14px; text-decoration: none; border: 1px solid var(--line); color: var(--ink);
  }
  .take-btn:hover { border-color: var(--ink-3); }
  .take-btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .take-btn-primary:hover { background: var(--accent-2); border-color: var(--accent-2); }
`;
