// GET /reel/<slug>/
// Server-rendered reader view for a single Reel piece. Returns inline HTML
// so the first paint is the actual content (no client-side fetch delay).
//
// Routing: the static `/reel/index.html` (built from src/pages/reel/index.astro)
// handles `/reel/` exactly; this Function handles every other `/reel/<slug>`
// request. Cloudflare Pages serves the matching static asset first, then
// falls through to the Function for anything else.
//
// Two modes:
//   - comic: horizontal snap-scroll strip, arrow-key + swipe nav
//   - gif:   stacked autoplay loop, CSS @keyframes panel cycling, pause-on-tap
//
// Completed pieces are cached at the edge for 5 minutes with stale-while-
// revalidate. In-flight pieces redirect to /reel/draft/<id>/. Missing or
// hidden slugs return a 404 page with a link back to /reel/.
//
// This is the skeleton tracked by roadmap item 1.1.3. The full reader view
// (item 1.4.4) layers on richer interactions and a Make-one-with-this-character
// affordance once the generate endpoints land.

import { type ReelEnv } from "../_reel-shared.ts";

type PieceRow = {
  id: string;
  slug: string;
  character_raw: string;
  character_enhanced: string | null;
  story_raw: string;
  story_enhanced: string | null;
  mode: "comic" | "gif";
  frame_count: number;
  master_ref_url: string | null;
  status: string;
  visible: number;
  completed_at: string | null;
  narration_voice_id: string | null;
  narration_url: string | null;
  narration_status: string | null;
  narration_duration_seconds: number | null;
  narration_panel_starts: string | null;
};

type FrameRow = {
  frame_index: number;
  image_url: string | null;
  status: string;
};

export const onRequestGet: PagesFunction<ReelEnv, "slug"> = async (ctx) => {
  const slug = String(ctx.params.slug ?? "").trim();
  if (!slug || slug.length > 80 || !/^[a-z0-9-]+$/i.test(slug)) {
    return notFound("That slug doesn't look right.");
  }

  let piece: PieceRow | null = null;
  try {
    piece = await ctx.env.DB
      .prepare(
        `SELECT id, slug, character_raw, character_enhanced, story_raw,
                story_enhanced, mode, frame_count, master_ref_url, status,
                visible, completed_at,
                narration_voice_id, narration_url, narration_status,
                narration_duration_seconds, narration_panel_starts
         FROM reel_pieces
         WHERE slug = ? AND visible = 1
         LIMIT 1`,
      )
      .bind(slug)
      .first<PieceRow>();
  } catch {
    // Table absent during pre-launch is the expected case. Fall through to 404.
    piece = null;
  }

  if (!piece) {
    return notFound("No piece by that slug. It may have been hidden or the URL might be wrong.");
  }

  // In-flight pieces live at /reel/draft/<id>/. Redirect there so the
  // reader URL is reserved for completed work.
  if (piece.status !== "completed") {
    return Response.redirect(
      new URL(`/reel/draft/${piece.id}/`, ctx.request.url).toString(),
      302,
    );
  }

  let frames: FrameRow[] = [];
  try {
    const result = await ctx.env.DB
      .prepare(
        `SELECT frame_index, image_url, status
         FROM reel_frames
         WHERE piece_id = ? AND status = 'accepted'
         ORDER BY frame_index ASC`,
      )
      .bind(piece.id)
      .all<FrameRow>();
    frames = result.results ?? [];
  } catch {
    frames = [];
  }

  const html = renderReader(piece, frames);
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      "Vary": "Accept-Encoding",
    },
  });
};

function notFound(detail: string): Response {
  const html = renderShell({
    title: "Reel · piece not found",
    canonical: "https://truffleagent.com/reel/",
    description: "This Reel piece is not available.",
    bodyClass: "reel-reader reel-reader-missing",
    bodyHtml: `
      <main class="reader-page">
        <p class="reader-eyebrow"><a href="/reel/">Back to Reel</a></p>
        <h1 class="reader-title">Nothing to read here.</h1>
        <p class="reader-lead">${escapeHtml(detail)}</p>
        <p class="reader-cta">
          <a class="reader-btn" href="/reel/">Open the studio</a>
        </p>
      </main>
    `,
  });
  return new Response(html, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}

function renderReader(piece: PieceRow, frames: FrameRow[]): string {
  const safeFrames = frames.filter((f) => !!f.image_url);
  const storyTitle = derivedTitle(piece.story_enhanced ?? piece.story_raw);
  const characterDesc = piece.character_enhanced ?? piece.character_raw;
  const storyDesc = piece.story_enhanced ?? piece.story_raw;
  const canonical = `https://truffleagent.com/reel/${encodeURIComponent(piece.slug)}/`;
  const ogImage = safeFrames[0]?.image_url ?? "";

  const remixUrl = `/reel/?character=${encodeURIComponent(piece.character_raw)}`;

  const stripHtml = piece.mode === "gif"
    ? renderGifStack(safeFrames)
    : renderComicStrip(safeFrames);

  const narrationHtml = renderNarrationBlock(piece);

  return renderShell({
    title: `${storyTitle} · Reel`,
    canonical,
    description: truncate(storyDesc, 200),
    ogImage,
    bodyClass: `reel-reader reel-reader-${piece.mode}`,
    bodyHtml: `
      <main class="reader-page">
        <header class="reader-head">
          <p class="reader-eyebrow"><a href="/reel/">Reel</a></p>
          <h1 class="reader-title">${escapeHtml(storyTitle)}</h1>
          <p class="reader-meta">
            ${piece.mode === "gif" ? "Animated loop" : "Comic strip"}
            <span class="reader-dot">·</span>
            ${safeFrames.length} panels
            ${piece.completed_at ? `<span class="reader-dot">·</span><time datetime="${escapeHtml(piece.completed_at)}">${formatDate(piece.completed_at)}</time>` : ""}
          </p>
        </header>

        <section class="reader-stage" aria-label="${piece.mode === "gif" ? "Animated reel" : "Comic strip"}">
          ${stripHtml}
        </section>

        <div id="reader-live" class="visually-hidden" aria-live="polite" aria-atomic="true"></div>

        ${narrationHtml}

        ${piece.mode === "comic" ? `
        <nav class="reader-nav" aria-label="Strip navigation">
          <button type="button" class="reader-nav-btn" data-dir="prev" aria-label="Previous panel">‹</button>
          <span class="reader-nav-counter"><span id="reader-frame-cur">1</span> / ${safeFrames.length}</span>
          <button type="button" class="reader-nav-btn" data-dir="next" aria-label="Next panel">›</button>
        </nav>
        <p class="reader-kbd-hint">Use the arrow keys, or <kbd>Home</kbd> and <kbd>End</kbd>.</p>` : `
        <p class="reader-gif-hint">Tap the loop to pause. Tap again to resume. <kbd>Space</kbd> works too.</p>`}

        <section class="reader-detail">
          <div class="reader-detail-block">
            <h2 class="reader-h2">The character</h2>
            <p class="reader-body">${escapeHtml(characterDesc)}</p>
          </div>
          <div class="reader-detail-block">
            <h2 class="reader-h2">The story</h2>
            <p class="reader-body">${escapeHtml(storyDesc)}</p>
          </div>
        </section>

        <section class="reader-cta-block" aria-label="Make your own">
          <a class="reader-btn reader-btn-primary" href="${escapeHtml(remixUrl)}">
            Make one with this character
          </a>
          <a class="reader-btn reader-btn-ghost" href="/reel/">
            Start fresh
          </a>
        </section>
      </main>

      <script>
        (function(){
          var mode = ${JSON.stringify(piece.mode)};
          var total = ${safeFrames.length};
          var reduceMotion = false;
          try {
            reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          } catch (_) {}
          var live = document.getElementById('reader-live');
          function announce(msg){ if (live) live.textContent = msg; }

          window.__reelReader = { gotoPanel: function(){} };

          if (mode === 'comic') {
            var stage = document.querySelector('.reader-strip');
            var cur = document.getElementById('reader-frame-cur');
            var nav = document.querySelector('.reader-nav');
            if (!stage || !nav || !cur) return;
            var idx = 0;
            function goto(i){
              if (i < 0) i = 0; if (i >= total) i = total - 1;
              idx = i;
              var panel = stage.children[i];
              if (panel) panel.scrollIntoView({
                behavior: reduceMotion ? 'auto' : 'smooth',
                block: 'nearest',
                inline: 'center',
              });
              cur.textContent = String(i + 1);
              announce('Panel ' + (i + 1) + ' of ' + total);
            }
            window.__reelReader.gotoPanel = goto;
            nav.addEventListener('click', function(e){
              var t = e.target;
              if (!(t instanceof HTMLElement)) return;
              var dir = t.getAttribute('data-dir');
              if (dir === 'prev') goto(idx - 1);
              if (dir === 'next') goto(idx + 1);
            });
            window.addEventListener('keydown', function(e){
              // Don't fight form fields.
              var t = e.target;
              if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
              if (e.key === 'ArrowLeft') { e.preventDefault(); goto(idx - 1); }
              else if (e.key === 'ArrowRight') { e.preventDefault(); goto(idx + 1); }
              else if (e.key === 'Home') { e.preventDefault(); goto(0); }
              else if (e.key === 'End') { e.preventDefault(); goto(total - 1); }
            });
            // Scroll watcher (rAF-debounced) — track centered panel.
            var scrollTick = 0;
            stage.addEventListener('scroll', function(){
              if (scrollTick) return;
              scrollTick = requestAnimationFrame(function(){
                scrollTick = 0;
                var children = stage.children;
                var stageRect = stage.getBoundingClientRect();
                var center = stageRect.left + stageRect.width / 2;
                var best = 0, bestDist = Infinity;
                for (var i = 0; i < children.length; i++) {
                  var r = children[i].getBoundingClientRect();
                  var cc = r.left + r.width / 2;
                  var d = Math.abs(cc - center);
                  if (d < bestDist) { bestDist = d; best = i; }
                }
                if (idx !== best) {
                  idx = best;
                  cur.textContent = String(best + 1);
                  announce('Panel ' + (best + 1) + ' of ' + total);
                }
              });
            }, { passive: true });
          } else if (mode === 'gif') {
            var loop = document.querySelector('.reader-gif');
            if (!loop) return;
            // Respect reduced motion: park on first frame, expose Play affordance.
            if (reduceMotion) loop.classList.add('paused');
            var paused = reduceMotion;
            function setPaused(v){
              paused = v;
              loop.classList.toggle('paused', paused);
              loop.setAttribute('aria-pressed', String(paused));
              announce(paused ? 'Animation paused' : 'Animation playing');
            }
            loop.setAttribute('role', 'button');
            loop.setAttribute('tabindex', '0');
            loop.setAttribute('aria-pressed', String(paused));
            loop.addEventListener('click', function(){ setPaused(!paused); });
            loop.addEventListener('keydown', function(e){
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                setPaused(!paused);
              }
            });
          }
        })();

        (function(){
          // Narration controller. Lazy-triggers /api/reel/synthesize-narration
          // on first reader load when the row has narration_voice_id set but
          // no narration_url yet. Once the audio element has a src, wires the
          // play/pause button and snaps comic panels to the timeline.
          var root = document.getElementById('reader-narration');
          if (!root) return;
          var mode = ${JSON.stringify(piece.mode)};
          var pieceId = root.getAttribute('data-piece-id') || '';
          var voiceId = root.getAttribute('data-voice-id') || '';
          var state = root.getAttribute('data-state') || 'pending';
          var statusEl = document.getElementById('reader-narration-status');
          var playBtn = document.getElementById('reader-narration-play');
          var bar = document.getElementById('reader-narration-progress-bar');
          var audio = document.getElementById('reader-narration-audio');
          if (!playBtn || !audio) return;

          var panelStarts = [];
          try {
            panelStarts = JSON.parse(root.getAttribute('data-panel-starts') || '[]') || [];
          } catch (_) { panelStarts = []; }

          function setStatus(msg){ if (statusEl) statusEl.textContent = msg; }

          function wireReady(url, starts){
            if (url) audio.src = url;
            if (Array.isArray(starts) && starts.length) panelStarts = starts;
            root.setAttribute('data-state', 'ready');
            playBtn.removeAttribute('disabled');
            setStatus('Tap to play');
          }

          function wireFailed(msg){
            root.setAttribute('data-state', 'failed');
            playBtn.removeAttribute('disabled');
            setStatus(msg || 'Voice prep failed — tap to retry');
          }

          function triggerSynthesis(){
            setStatus('Preparing voice…');
            playBtn.setAttribute('disabled', 'true');
            fetch('/api/reel/synthesize-narration/' + encodeURIComponent(pieceId), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ voice_id: voiceId }),
            })
              .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, json: j }; }); })
              .then(function(res){
                if (!res.ok || !res.json || !res.json.ok) {
                  var msg = (res.json && res.json.error && res.json.error.message) || 'Voice prep failed';
                  wireFailed(msg);
                  return;
                }
                wireReady(res.json.url, res.json.panel_starts);
              })
              .catch(function(){ wireFailed('Network error preparing voice'); });
          }

          if (state === 'ready' && audio.src) {
            setStatus('Tap to play');
          } else {
            triggerSynthesis();
          }

          var lastPanel = -1;
          function syncPanel(){
            if (mode !== 'comic' || !panelStarts.length) return;
            var t = audio.currentTime || 0;
            var p = 0;
            for (var i = 0; i < panelStarts.length; i++) {
              if (t + 0.05 >= panelStarts[i]) p = i; else break;
            }
            if (p !== lastPanel) {
              lastPanel = p;
              if (window.__reelReader && typeof window.__reelReader.gotoPanel === 'function') {
                window.__reelReader.gotoPanel(p);
              }
            }
          }

          playBtn.addEventListener('click', function(){
            if (root.getAttribute('data-state') === 'failed') {
              triggerSynthesis();
              return;
            }
            if (!audio.src) return;
            if (audio.paused) {
              var pr = audio.play();
              if (pr && typeof pr.catch === 'function') pr.catch(function(){ setStatus('Tap again to play'); });
            } else {
              audio.pause();
            }
          });

          audio.addEventListener('play', function(){
            playBtn.setAttribute('data-playing', 'true');
            playBtn.querySelector('span').textContent = '▮▮';
            setStatus('Playing');
          });
          audio.addEventListener('pause', function(){
            playBtn.setAttribute('data-playing', 'false');
            playBtn.querySelector('span').textContent = '▶';
            setStatus(audio.ended ? 'Done' : 'Paused');
          });
          audio.addEventListener('ended', function(){
            playBtn.setAttribute('data-playing', 'false');
            playBtn.querySelector('span').textContent = '▶';
            setStatus('Done');
            if (bar) bar.style.width = '100%';
            lastPanel = -1;
          });
          audio.addEventListener('timeupdate', function(){
            var d = audio.duration || 0;
            if (d > 0 && bar) {
              bar.style.width = Math.min(100, (audio.currentTime / d) * 100) + '%';
            }
            syncPanel();
          });
        })();
      </script>
    `,
  });
}

function renderComicStrip(frames: FrameRow[]): string {
  if (frames.length === 0) {
    return `<div class="reader-strip-empty">No frames available yet.</div>`;
  }
  return `
    <div class="reader-strip" tabindex="0">
      ${frames.map((f, i) => `
        <figure class="reader-panel" data-i="${i}">
          <img src="${escapeHtml(f.image_url ?? "")}" alt="Panel ${i + 1}" loading="${i < 2 ? "eager" : "lazy"}" decoding="async" />
          <figcaption class="reader-panel-cap">${i + 1} / ${frames.length}</figcaption>
        </figure>
      `).join("")}
    </div>
  `;
}

function renderGifStack(frames: FrameRow[]): string {
  if (frames.length === 0) {
    return `<div class="reader-strip-empty">No frames available yet.</div>`;
  }
  const N = frames.length;
  // CSS keyframes: each frame visible for 1/N of an 8-second loop.
  const slicePct = (100 / N).toFixed(3);
  const stepPct = (100 / N).toFixed(3);
  const keyframes = frames.map((_, i) => {
    const from = (i * Number(stepPct)).toFixed(3);
    const to = ((i + 1) * Number(stepPct)).toFixed(3);
    return `${from}%, ${to}% { opacity: 1; }`;
  }).join("\n      ");
  const inlineKeyframes = `
    .reader-gif-cell-i {
      opacity: 0;
      animation: reader-gif-cycle ${(N * 0.7).toFixed(1)}s steps(1, end) infinite;
    }
    ${frames.map((_, i) => `
      .reader-gif-cell-i[data-cell="${i}"] {
        animation-delay: ${(i * 0.7).toFixed(2)}s;
      }`).join("")}
    @keyframes reader-gif-cycle {
      0%, ${slicePct}% { opacity: 1; }
      ${(Number(slicePct) + 0.001).toFixed(3)}%, 100% { opacity: 0; }
    }
    .reader-gif.paused .reader-gif-cell-i { animation-play-state: paused; }
  `;
  return `
    <style>${inlineKeyframes}</style>
    <div class="reader-gif" role="img" aria-label="Animated loop">
      ${frames.map((f, i) => `
        <img class="reader-gif-cell-i" data-cell="${i}"
             src="${escapeHtml(f.image_url ?? "")}" alt=""
             loading="${i < 2 ? "eager" : "lazy"}" decoding="async" />
      `).join("")}
    </div>
  `;
}

type ShellOpts = {
  title: string;
  canonical: string;
  description: string;
  ogImage?: string;
  bodyClass: string;
  bodyHtml: string;
};

function renderShell(opts: ShellOpts): string {
  const og = opts.ogImage
    ? `<meta property="og:image" content="${escapeHtml(opts.ogImage)}" />`
    : "";
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
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${escapeHtml(opts.canonical)}" />
  <meta property="og:title" content="${escapeHtml(opts.title)}" />
  <meta property="og:description" content="${escapeHtml(opts.description)}" />
  ${og}
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;1,9..144,400;1,9..144,500&family=JetBrains+Mono:wght@400;500&display=swap"
    rel="stylesheet"
  />
  <style>${READER_CSS}</style>
</head>
<body class="${escapeHtml(opts.bodyClass)}">
  <nav class="reader-bar" aria-label="Site">
    <a class="reader-bar-brand" href="/">Truffle</a>
    <a class="reader-bar-link" href="/reel/">Reel</a>
  </nav>
  ${opts.bodyHtml}
</body>
</html>`;
}

const READER_CSS = `
  :root {
    --paper: #fbfaf5;
    --paper-2: #f4f1e8;
    --paper-3: #e9e4d4;
    --ink: #1a1612;
    --ink-2: #3a342b;
    --ink-3: #736a52;
    --line: #d8d1bd;
    --accent: #b8472d;
    --accent-2: #9a3a23;
    --font-serif: "Fraunces", Georgia, serif;
    --font-sans: "Inter", system-ui, sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, monospace;
    --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #0e0c08;
      --paper-2: #18140e;
      --paper-3: #221c14;
      --ink: #f4f0e6;
      --ink-2: #ccc4ad;
      --ink-3: #998c70;
      --line: #2d2618;
      --accent: #d36a4e;
      --accent-2: #b8472d;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--paper);
    color: var(--ink);
    font-family: var(--font-sans);
    font-size: 16px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .reader-bar {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 16px 24px;
    border-bottom: 1px solid var(--line);
    background: var(--paper);
  }
  .reader-bar a {
    color: var(--ink);
    text-decoration: none;
    font-size: 14px;
  }
  .reader-bar-brand {
    font-family: var(--font-serif);
    font-size: 18px;
    font-weight: 500;
  }
  .reader-bar-link {
    color: var(--ink-3) !important;
    font-family: var(--font-mono);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }
  .reader-bar-link:hover { color: var(--ink) !important; }

  .reader-page {
    max-width: 1100px;
    margin: 0 auto;
    padding: 48px 24px 96px;
  }
  .reader-eyebrow {
    margin: 0 0 12px;
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
  }
  .reader-eyebrow a {
    color: var(--ink-3);
    text-decoration: none;
  }
  .reader-eyebrow a:hover { color: var(--accent); }
  .reader-title {
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: clamp(32px, 5vw, 52px);
    line-height: 1.08;
    letter-spacing: -0.01em;
    color: var(--ink);
    margin: 0 0 16px;
  }
  .reader-meta {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ink-3);
    margin: 0 0 36px;
  }
  .reader-dot {
    margin: 0 6px;
    color: var(--ink-3);
  }
  .reader-head { max-width: 760px; }

  /* ---------- Comic strip stage ---------- */
  .reader-stage {
    margin: 0 -24px 24px;
    padding: 24px 0;
    background: var(--paper-2);
    border-block: 1px solid var(--line);
  }
  .reader-strip {
    display: flex;
    gap: 16px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scroll-padding: 0 24px;
    padding: 0 24px;
    scrollbar-width: thin;
  }
  .reader-strip-empty {
    text-align: center;
    color: var(--ink-3);
    padding: 48px 24px;
  }
  .reader-panel {
    flex: 0 0 auto;
    margin: 0;
    width: min(640px, 86vw);
    scroll-snap-align: center;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 14px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .reader-panel img {
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: 1 / 1;
    object-fit: cover;
    background: var(--paper-3);
  }
  .reader-panel-cap {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--ink-3);
    text-align: center;
    padding: 8px;
    border-top: 1px solid var(--line);
  }

  /* ---------- GIF loop stage ---------- */
  .reader-gif {
    position: relative;
    width: min(640px, 86vw);
    aspect-ratio: 1 / 1;
    margin: 0 auto;
    background: var(--paper-3);
    border: 1px solid var(--line);
    border-radius: 14px;
    overflow: hidden;
    cursor: pointer;
  }
  .reader-gif:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 4px;
  }
  .reader-gif img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .reader-gif::after {
    content: '';
    position: absolute;
    inset: 0;
    margin: auto;
    width: 0;
    height: 0;
    border-style: solid;
    border-width: 18px 0 18px 30px;
    border-color: transparent transparent transparent rgba(255, 255, 255, 0.92);
    filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.5));
    opacity: 0;
    transition: opacity 180ms var(--ease-out);
    pointer-events: none;
  }
  .reader-gif.paused::after { opacity: 1; }
  .reader-gif.paused::before {
    content: '';
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.22);
    transition: opacity 180ms var(--ease-out);
    pointer-events: none;
  }
  .reader-gif-hint,
  .reader-kbd-hint {
    text-align: center;
    margin: 18px 0 32px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--ink-3);
  }
  .reader-gif-hint kbd,
  .reader-kbd-hint kbd {
    display: inline-block;
    padding: 1px 6px;
    margin: 0 2px;
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-bottom-width: 2px;
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--ink-2);
  }

  /* ---------- a11y helpers ---------- */
  .visually-hidden {
    position: absolute !important;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden;
    clip: rect(0,0,0,0);
    white-space: nowrap;
    border: 0;
  }
  .reader-strip:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 4px;
  }
  .reader-nav-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* ---------- Nav row ---------- */
  .reader-nav {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    margin: 18px 0 32px;
  }
  .reader-nav-btn {
    background: var(--paper-2);
    border: 1px solid var(--line);
    color: var(--ink);
    width: 40px;
    height: 40px;
    border-radius: 999px;
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    transition: background 150ms var(--ease-out), border-color 150ms var(--ease-out);
  }
  .reader-nav-btn:hover {
    background: var(--paper-3);
    border-color: var(--accent);
  }
  .reader-nav-counter {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ink-3);
    min-width: 72px;
    text-align: center;
  }

  /* ---------- Detail ---------- */
  .reader-detail {
    display: grid;
    grid-template-columns: 1fr;
    gap: 32px;
    margin: 48px 0;
    max-width: 760px;
  }
  @media (min-width: 760px) {
    .reader-detail { grid-template-columns: 1fr 1fr; }
  }
  .reader-h2 {
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 22px;
    margin: 0 0 12px;
  }
  .reader-body {
    margin: 0;
    color: var(--ink-2);
    line-height: 1.6;
    font-size: 15px;
  }

  /* ---------- CTA + buttons ---------- */
  .reader-cta-block,
  .reader-cta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 32px;
  }
  .reader-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 12px 22px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--paper);
    color: var(--ink);
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
    transition: border-color 150ms var(--ease-out), background 150ms var(--ease-out);
  }
  .reader-btn:hover { border-color: var(--accent); }
  .reader-btn-primary {
    background: var(--accent);
    color: #fff;
    border-color: transparent;
  }
  .reader-btn-primary:hover {
    background: var(--accent-2);
    border-color: transparent;
  }
  .reader-btn-ghost { background: transparent; }

  /* ---------- Narration player ---------- */
  .reader-narration {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 28px auto 0;
    padding: 14px 18px;
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 14px;
    max-width: 640px;
  }
  .reader-narration[data-state="hidden"] { display: none; }
  .reader-narration[data-state="failed"] {
    border-color: color-mix(in oklab, #b04040 50%, var(--line));
  }
  .reader-narration-play {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1px solid var(--line);
    background: var(--paper);
    color: var(--ink);
    cursor: pointer;
    font-size: 16px;
    transition: border-color 150ms var(--ease-out), background 150ms var(--ease-out);
  }
  .reader-narration-play:hover:not([disabled]) {
    border-color: var(--accent);
    background: color-mix(in oklab, var(--accent) 8%, var(--paper));
  }
  .reader-narration-play[disabled] {
    cursor: progress;
    opacity: 0.55;
  }
  .reader-narration-play[data-playing="true"] {
    background: var(--accent);
    color: #fff;
    border-color: transparent;
  }
  .reader-narration-meta {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .reader-narration-label {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .reader-narration-status {
    font-family: var(--font-sans);
    font-size: 13px;
    color: var(--ink-2);
  }
  .reader-narration-progress {
    height: 4px;
    background: color-mix(in oklab, var(--ink) 8%, var(--paper));
    border-radius: 999px;
    overflow: hidden;
    margin-top: 4px;
  }
  .reader-narration-progress-bar {
    height: 100%;
    width: 0%;
    background: var(--accent);
    border-radius: 999px;
    transition: width 200ms linear;
  }

  /* ---------- 404 shape ---------- */
  .reader-reader-missing .reader-title { margin-top: 32px; }
  .reader-reader-missing .reader-lead {
    color: var(--ink-2);
    font-size: 17px;
    max-width: 56ch;
    margin: 0 0 24px;
  }
`;

// ---------- helpers ----------

const VOICE_LABELS: Record<string, string> = {
  jessica: "Jessica reads it",
  callum: "Callum reads it",
  charlie: "Charlie reads it",
  laura: "Laura reads it",
};

function renderNarrationBlock(piece: PieceRow): string {
  const voiceId = piece.narration_voice_id;
  if (!voiceId) return "";
  const label = VOICE_LABELS[voiceId] ?? `${voiceId} reads it`;
  const status = piece.narration_status ?? "pending";
  const url = piece.narration_url ?? "";
  let panelStarts = "[]";
  if (piece.narration_panel_starts) {
    try {
      const parsed = JSON.parse(piece.narration_panel_starts);
      if (Array.isArray(parsed)) {
        const nums = parsed
          .map((x) => Number(x))
          .filter((x) => Number.isFinite(x));
        panelStarts = JSON.stringify(nums);
      }
    } catch {
      panelStarts = "[]";
    }
  }
  const initialStateMsg =
    status === "ready" ? "Tap to play" :
    status === "failed" ? "Voice prep failed — tap to retry" :
    "Preparing voice…";
  return `
    <section class="reader-narration"
             id="reader-narration"
             data-state="${escapeHtml(status)}"
             data-piece-id="${escapeHtml(piece.id)}"
             data-voice-id="${escapeHtml(voiceId)}"
             data-panel-starts='${panelStarts}'
             aria-label="Narration">
      <button type="button"
              class="reader-narration-play"
              id="reader-narration-play"
              data-playing="false"
              ${status !== "ready" ? "disabled" : ""}
              aria-label="Play narration">
        <span aria-hidden="true">▶</span>
      </button>
      <div class="reader-narration-meta">
        <span class="reader-narration-label">${escapeHtml(label)}</span>
        <span class="reader-narration-status" id="reader-narration-status">${escapeHtml(initialStateMsg)}</span>
        <div class="reader-narration-progress" aria-hidden="true">
          <div class="reader-narration-progress-bar" id="reader-narration-progress-bar"></div>
        </div>
      </div>
      <audio id="reader-narration-audio"
             preload="metadata"
             ${url ? `src="${escapeHtml(url)}"` : ""}></audio>
    </section>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

function derivedTitle(story: string): string {
  const first = story.split(/[.\n]/)[0]?.trim() ?? "";
  if (!first) return "A Reel piece";
  return truncate(first, 80);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}
