// GET /cut/draft/<id>/
// The Studio: live view of a Cut piece being planned, shot, chained,
// stitched, and judged. The page does two jobs at once:
//   1. Drives the pipeline. /api/cut/status/<id> advances the state machine
//      one bounded step per poll, so the poll loop here IS the heartbeat.
//   2. Shows the edit live. The EDL timeline strip renders the composition
//      document as an NLE timeline (shot blocks, transition markers, seam
//      dots), the chain DAG shows conditioning edges, and SSE from
//      /api/cut/stream/<id> relays the bridge channel: plan/compose
//      reasoning, engine stage events, and judge tokens as Claude writes
//      each verdict.
//
// Redirects to the reader view (/cut/<slug>/) once the piece completes.

import { type CutEnv, PIECE_ID_RE, SHOT_SECONDS } from "../../_cut-shared.ts";

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
  revision_round: number;
  visible: number;
  error_log: string | null;
  cost_usd: number;
};

export const onRequestGet: PagesFunction<CutEnv> = async (ctx) => {
  // Catch-all friendly: derive the id from the path, tolerate trailing slash.
  const url = new URL(ctx.request.url);
  const id = url.pathname.replace(/^\/cut\/draft\//, "").replace(/\/+$/, "");
  if (!PIECE_ID_RE.test(id)) return notFound("That draft id doesn't look right.");

  let piece: PieceRow | null = null;
  try {
    piece = await ctx.env.DB.prepare(
      `SELECT id, slug, prompt_raw, title, aspect_ratio, resolution,
              target_seconds, status, current_version, revision_round,
              visible, error_log, cost_usd
         FROM cut_pieces WHERE id = ?1 LIMIT 1`,
    )
      .bind(id)
      .first<PieceRow>();
  } catch {
    piece = null;
  }
  if (!piece) return notFound("No cut by that id. It may have been cleaned up.");

  if (piece.status === "completed" && piece.visible) {
    return Response.redirect(
      new URL(`/cut/${encodeURIComponent(piece.slug)}/`, ctx.request.url).toString(),
      302,
    );
  }

  return new Response(renderStudio(piece), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, max-age=5",
    },
  });
};

function notFound(detail: string): Response {
  const html = renderShell({
    title: "Cut · draft not found",
    canonical: "https://truffleagent.com/cut/",
    description: "This Cut draft is not available.",
    bodyHtml: `
      <main class="studio-page">
        <p class="reader-eyebrow"><a href="/cut/">Back to Cut</a></p>
        <h1 class="reader-title">Nothing on the timeline here.</h1>
        <p class="reader-body">${escapeHtml(detail)}</p>
        <p><a class="cut-btn cut-btn-primary" href="/cut/">Open the studio</a></p>
      </main>`,
  });
  return new Response(html, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
  });
}

const SHOT_AXES = ["fidelity", "aesthetics", "consistency", "motion", "semantics", "physics"] as const;
const CUT_AXES = [...SHOT_AXES, "continuity"] as const;

function renderStudio(piece: PieceRow): string {
  const title = piece.title || derivedTitle(piece.prompt_raw);
  const shotCount = Math.max(2, Math.min(6, Math.round(piece.target_seconds / SHOT_SECONDS)));

  // SSR skeleton: placeholder EDL blocks until the planner writes the
  // composition. The client rebuilds the strip from snapshot.composition.
  const placeholderBlocks = Array.from({ length: shotCount }, (_, i) => {
    const tr =
      i < shotCount - 1
        ? `<div class="edl-tr" data-ph-tr="${i}"><span class="edl-tr-bar"></span><span class="edl-tr-label">cut</span></div>`
        : "";
    return `
      <div class="edl-block" data-ph="${i}" data-state="pending">
        <div class="edl-thumb"><span class="edl-thumb-empty">s${i + 1}</span></div>
        <div class="edl-block-meta">
          <span class="edl-id">s${i + 1}</span>
          <span class="edl-dur">${SHOT_SECONDS}s</span>
          <span class="edl-state" data-state-label>queued</span>
        </div>
      </div>${tr}`;
  }).join("");

  const finalAxisRows = CUT_AXES.map(
    (a) => `
      <div class="axis-row" data-axis="${a}" data-level="">
        <span class="axis-name">${a}</span>
        <span class="axis-level" data-level-label>—</span>
        <span class="axis-rationale" data-rationale></span>
      </div>`,
  ).join("");

  return renderShell({
    title: `Directing · ${title} · Cut`,
    canonical: `https://truffleagent.com/cut/draft/${piece.id}/`,
    description: `A Cut piece is being planned, shot, stitched, and judged. ${piece.target_seconds}s, ${shotCount} shots, ${piece.resolution}.`,
    bodyHtml: `
      <main class="studio-page">
        <header class="studio-head">
          <p class="reader-eyebrow"><a href="/cut/">Cut</a> · the studio</p>
          <h1 class="reader-title" id="piece-title">${escapeHtml(title)}</h1>
          <p class="reader-meta">
            <span class="draft-status" id="status-label">${escapeHtml(humanStatusSSR(piece.status))}</span>
            <span class="reader-dot">·</span>
            <span id="version-label">v${piece.current_version}</span>
            <span class="reader-dot">·</span>
            <span id="cost-label">$${piece.cost_usd.toFixed(3)}</span>
            <span class="reader-dot">·</span>
            <span class="mono">${piece.target_seconds}s / ${shotCount} shots / ${escapeHtml(piece.resolution)} / ${escapeHtml(piece.aspect_ratio)}</span>
            <span id="revision-label"${piece.revision_round > 0 ? "" : " hidden"}><span class="reader-dot">·</span>revision ${piece.revision_round} of 5</span>
          </p>
        </header>

        <section class="draft-narration" aria-live="polite" aria-label="Live narration">
          <p class="draft-narration-eyebrow">The director · live</p>
          <h2 class="draft-narration-title"><span id="narration-headline">Waking the studio</span><span class="draft-narration-cursor" aria-hidden="true"></span></h2>
          <p class="draft-narration-body" id="narration-body">
            The agent is about to read your prompt and write a shot list. Everything below is the real edit decision list, not a progress bar: every block, every junction, and every score is data from the pipeline.
          </p>
        </section>

        <div class="studio-grid">
          <div class="studio-main">

            <section aria-label="Timeline">
              <h2 class="reader-h2">The timeline <span class="reader-h2-aside" id="timeline-aside">edit decision list, live</span></h2>
              <div class="edl-strip" id="edl-strip">${placeholderBlocks}</div>
              <div class="edl-seams" id="edl-seams" hidden></div>
            </section>

            <section aria-label="Conditioning chain">
              <h2 class="reader-h2">The chain <span class="reader-h2-aside">each shot starts from the last frame of the one before</span></h2>
              <div class="chain-dag" id="chain-dag">
                <span class="chain-empty" id="chain-empty">The planner decides the conditioning edges. They appear here the moment the shot list lands.</span>
              </div>
            </section>

            <section aria-label="Final act" id="final-wrap" hidden>
              <h2 class="reader-h2">The final cut</h2>
              <p class="cut-hint" id="final-progress" hidden></p>
              <div class="cut-player-wrap" id="final-player-wrap" hidden>
                <video class="cut-player" id="final-player" controls playsinline preload="metadata"></video>
              </div>
              <div class="final-sheets" id="final-sheets" hidden>
                <figure class="final-sheet-fig"><img id="final-sheet-img" alt="Final contact sheet" loading="lazy" decoding="async" /><figcaption>Final contact sheet</figcaption></figure>
                <figure class="final-sheet-fig"><img id="seam-sheet-img" alt="Seam sheet: frames either side of every cut" loading="lazy" decoding="async" /><figcaption>Seam sheet</figcaption></figure>
              </div>
              <div class="axis-grid" id="final-axis-grid" hidden>${finalAxisRows}</div>
              <p class="judge-summary" id="final-judge-summary" hidden></p>
              <p class="cut-hint" id="final-link-row" hidden><a id="final-link" class="cut-btn cut-btn-primary" href="/cut/">Open the finished piece</a></p>
            </section>

            <section aria-label="Shots">
              <h2 class="reader-h2">The shots</h2>
              <p class="cut-hint">One card per shot. Each shot is composed, rendered on ray-3.2, measured by the deterministic gates and CV lanes, then judged on six axes before it earns its place on the timeline.</p>
              <div id="shot-cards"></div>
            </section>

            <section id="errors-wrap" aria-label="Pipeline issues"${piece.error_log ? "" : " hidden"}>
              <h2 class="reader-h2">Pipeline issues</h2>
              <p class="cut-hint">Non-fatal errors the driver retried. Most recover on the next pass.</p>
              <pre class="draft-errors-pre" id="errors-pre">${piece.error_log ? escapeHtml(piece.error_log) : ""}</pre>
            </section>

            <section class="reader-detail-block">
              <h2 class="reader-h2">Your prompt</h2>
              <p class="reader-body">${escapeHtml(piece.prompt_raw)}</p>
            </section>
          </div>

          <aside class="studio-rail" aria-label="Agent stream">
            <section>
              <h3 class="rail-h">The judge <span class="draft-agent-dot" id="agent-dot" title="stream status" aria-hidden="true"></span></h3>
              <p class="rail-hint" id="judge-context">Verdicts stream here token by token as Claude writes them.</p>
              <pre class="judge-stream" id="judge-stream" hidden></pre>
            </section>
            <section>
              <h3 class="rail-h">Live log</h3>
              <ol class="draft-log" id="live-log">
                <li><span class="draft-log-when">just now</span> studio opened, driving the pipeline</li>
              </ol>
            </section>
          </aside>
        </div>
      </main>

      <script>
        (function(){
          var id = ${JSON.stringify(piece.id)};
          var done = false;
          var pollInterval = 3500;
          var consecutiveErrors = 0;
          var lastStatus = ${JSON.stringify(piece.status)};
          var lastVersion = ${piece.current_version};
          var lastErrorLog = '';
          var compSignature = '';
          var judgeStreamText = '';
          var seenLog = {};

          var $ = function(s){ return document.getElementById(s); };
          var statusLabel = $('status-label');
          var versionLabel = $('version-label');
          var costLabel = $('cost-label');
          var revisionLabel = $('revision-label');
          var pieceTitle = $('piece-title');
          var narrationHeadline = $('narration-headline');
          var narrationBody = $('narration-body');
          var edlStrip = $('edl-strip');
          var edlSeams = $('edl-seams');
          var chainDag = $('chain-dag');
          var chainEmpty = $('chain-empty');
          var shotCards = $('shot-cards');
          var finalWrap = $('final-wrap');
          var finalProgress = $('final-progress');
          var finalPlayerWrap = $('final-player-wrap');
          var finalPlayer = $('final-player');
          var finalSheets = $('final-sheets');
          var finalSheetImg = $('final-sheet-img');
          var seamSheetImg = $('seam-sheet-img');
          var finalAxisGrid = $('final-axis-grid');
          var finalJudgeSummary = $('final-judge-summary');
          var finalLinkRow = $('final-link-row');
          var finalLink = $('final-link');
          var liveLog = $('live-log');
          var errorsWrap = $('errors-wrap');
          var errorsPre = $('errors-pre');
          var judgeStream = $('judge-stream');
          var judgeContext = $('judge-context');
          var agentDot = $('agent-dot');
          lastErrorLog = errorsPre ? errorsPre.textContent : '';

          function logLine(text) {
            var li = document.createElement('li');
            var when = document.createElement('span');
            when.className = 'draft-log-when';
            when.textContent = new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
            li.appendChild(when);
            li.appendChild(document.createTextNode(' ' + text));
            liveLog.insertBefore(li, liveLog.firstChild);
            while (liveLog.children.length > 120) liveLog.removeChild(liveLog.lastChild);
          }
          function logOnce(key, text) {
            if (seenLog[key]) return;
            seenLog[key] = 1;
            logLine(text);
          }

          function narrate(title, body) {
            if (narrationHeadline.textContent !== title) narrationHeadline.textContent = title;
            if (body && narrationBody.textContent !== body) narrationBody.textContent = body;
          }

          function narrationFor(status) {
            switch (status) {
              case 'queued': case 'planning':
                return ['Writing the shot list', 'The director reads your prompt and breaks it into shots: one prompt per shot, a shared style block, and the transitions between them. The timeline below fills in the moment the plan lands.'];
              case 'shooting':
                return ['Shooting, in order', 'Shots render one at a time because each one is conditioned on the last frame of the shot before it. That chain is what keeps the cut continuous.'];
              case 'stitching':
                return ['Stitching the cut', 'Every shot is accepted. The engine normalizes the clips, assembles the timeline with its transitions, and photographs every seam for the judge.'];
              case 'judging':
                return ['The final judge is reading', 'Claude has the final contact sheet and the seam sheet side by side. Seven axes, including continuity across every cut. The verdict streams in the rail.'];
              case 'revising':
                return ['Routing your edit', 'The director is reading your note and deciding which shots it touches. Timeline-only changes re-cut for free; content changes re-shoot only what changed.'];
              case 'completed':
                return ['The cut is in. Routing you to the piece.', 'The final verdict accepted the sequence. Redirecting to the finished piece with the full edit receipt.'];
              case 'failed':
                return ['The pipeline hit a wall', 'A hard failure or exhausted budget. The issues section has the trail.'];
              default:
                return ['Working', 'Status: ' + status];
            }
          }

          var shotStateLabel = {
            composing: 'composing', generating: 'rendering', ingesting: 'ingesting',
            evaluating: 'measuring', judging: 'judging', accepted: 'accepted',
            stitching: 'carried', retake: 'retaking', failed: 'failed'
          };
          var shotStateClass = {
            composing: 'active', generating: 'active', ingesting: 'active',
            evaluating: 'active', judging: 'active', accepted: 'done',
            stitching: 'done', retake: 'warn', failed: 'fail'
          };

          // ---- timeline (EDL strip) ----

          function buildTimeline(comp) {
            edlStrip.innerHTML = '';
            var shots = comp.shots.slice().sort(function(a,b){ return a.order - b.order; });
            var trByAfter = {};
            (comp.transitions || []).forEach(function(t){ trByAfter[t.after] = t; });
            shots.forEach(function(s, i) {
              var block = document.createElement('div');
              block.className = 'edl-block';
              block.dataset.shot = s.id;
              block.dataset.state = 'pending';

              var thumb = document.createElement('div');
              thumb.className = 'edl-thumb';
              var empty = document.createElement('span');
              empty.className = 'edl-thumb-empty';
              empty.textContent = s.id;
              thumb.appendChild(empty);
              block.appendChild(thumb);

              var meta = document.createElement('div');
              meta.className = 'edl-block-meta';
              var idEl = document.createElement('a');
              idEl.className = 'edl-id';
              idEl.href = '#card-' + s.id;
              idEl.textContent = s.id;
              meta.appendChild(idEl);
              var dur = document.createElement('span');
              dur.className = 'edl-dur';
              dur.textContent = (s.duration_s || ${SHOT_SECONDS}) + 's';
              meta.appendChild(dur);
              var state = document.createElement('span');
              state.className = 'edl-state';
              state.setAttribute('data-state-label', '');
              state.textContent = 'queued';
              meta.appendChild(state);
              var score = document.createElement('span');
              score.className = 'edl-score';
              score.setAttribute('data-score', '');
              meta.appendChild(score);
              block.appendChild(meta);

              edlStrip.appendChild(block);

              if (i < shots.length - 1) {
                var t = trByAfter[s.id] || { type: 'cut', duration: 0 };
                var tr = document.createElement('div');
                tr.className = 'edl-tr';
                tr.dataset.after = s.id;
                var bar = document.createElement('span');
                bar.className = t.type === 'xfade' ? 'edl-tr-wedge' : 'edl-tr-bar';
                tr.appendChild(bar);
                var lbl = document.createElement('span');
                lbl.className = 'edl-tr-label';
                lbl.textContent = t.type === 'xfade' ? ('xfade ' + (t.duration || 0) + 's') : 'cut';
                tr.appendChild(lbl);
                edlStrip.appendChild(tr);
              }
            });
          }

          function buildChain(comp) {
            chainDag.innerHTML = '';
            var shots = comp.shots.slice().sort(function(a,b){ return a.order - b.order; });
            shots.forEach(function(s, i) {
              if (i > 0) {
                var prev = shots[i - 1];
                var chained = s.conditioning && s.conditioning.mode === 'chain';
                var edge = document.createElement('span');
                edge.className = 'chain-edge';
                edge.dataset.into = s.id;
                edge.dataset.kind = chained ? 'chain' : 'free';
                var lbl = document.createElement('span');
                lbl.className = 'chain-edge-label';
                lbl.textContent = chained ? 'last frame' : 'free';
                edge.appendChild(lbl);
                chainDag.appendChild(edge);
                void prev;
              }
              var node = document.createElement('span');
              node.className = 'chain-node';
              node.dataset.shot = s.id;
              var circ = document.createElement('span');
              circ.className = 'chain-node-thumb';
              circ.textContent = s.id;
              node.appendChild(circ);
              chainDag.appendChild(node);
            });
          }

          function buildCards(comp) {
            shotCards.innerHTML = '';
            var shots = comp.shots.slice().sort(function(a,b){ return a.order - b.order; });
            shots.forEach(function(s) {
              var card = document.createElement('article');
              card.className = 'shot-card';
              card.id = 'card-' + s.id;
              card.dataset.shot = s.id;

              var head = document.createElement('div');
              head.className = 'shot-card-head';
              var hid = document.createElement('span');
              hid.className = 'shot-card-id';
              hid.textContent = s.id;
              head.appendChild(hid);
              var hstate = document.createElement('span');
              hstate.className = 'shot-card-state';
              hstate.setAttribute('data-card-state', '');
              hstate.textContent = 'queued';
              head.appendChild(hstate);
              var hattempt = document.createElement('span');
              hattempt.className = 'shot-card-attempt';
              hattempt.setAttribute('data-card-attempt', '');
              head.appendChild(hattempt);
              var hscore = document.createElement('span');
              hscore.className = 'shot-card-score';
              hscore.setAttribute('data-card-score', '');
              head.appendChild(hscore);
              card.appendChild(head);

              var prompt = document.createElement('p');
              prompt.className = 'shot-card-prompt';
              prompt.setAttribute('data-card-prompt', '');
              prompt.textContent = s.prompt || '';
              card.appendChild(prompt);

              var vidWrap = document.createElement('div');
              vidWrap.className = 'shot-card-video';
              vidWrap.setAttribute('data-card-video', '');
              vidWrap.hidden = true;
              card.appendChild(vidWrap);

              var gates = document.createElement('div');
              gates.className = 'shot-card-gates';
              gates.setAttribute('data-card-gates', '');
              gates.hidden = true;
              card.appendChild(gates);

              var axes = document.createElement('div');
              axes.className = 'axis-grid axis-grid-compact';
              axes.setAttribute('data-card-axes', '');
              axes.hidden = true;
              ${JSON.stringify(SHOT_AXES)}.forEach(function(a){
                var row = document.createElement('div');
                row.className = 'axis-row';
                row.dataset.axis = a;
                var nm = document.createElement('span');
                nm.className = 'axis-name';
                nm.textContent = a;
                row.appendChild(nm);
                var lv = document.createElement('span');
                lv.className = 'axis-level';
                lv.setAttribute('data-level-label', '');
                lv.textContent = '—';
                row.appendChild(lv);
                var rat = document.createElement('span');
                rat.className = 'axis-rationale';
                rat.setAttribute('data-rationale', '');
                row.appendChild(rat);
                axes.appendChild(row);
              });
              card.appendChild(axes);

              var note = document.createElement('p');
              note.className = 'shot-card-note';
              note.setAttribute('data-card-note', '');
              note.hidden = true;
              card.appendChild(note);

              shotCards.appendChild(card);
            });
          }

          function ensureComposition(comp) {
            if (!comp || !Array.isArray(comp.shots) || !comp.shots.length) return;
            var sig = comp.version + ':' + comp.shots.map(function(s){ return s.id + '@' + s.order; }).join(',')
              + '|' + (comp.transitions || []).map(function(t){ return t.after + ':' + t.type + ':' + (t.duration || 0); }).join(',');
            if (sig === compSignature) return;
            compSignature = sig;
            buildTimeline(comp);
            buildChain(comp);
            buildCards(comp);
            if (comp.title && pieceTitle.textContent !== comp.title) {
              pieceTitle.textContent = comp.title;
              document.title = 'Directing \\u00b7 ' + comp.title + ' \\u00b7 Cut';
            }
            logOnce('plan:v' + comp.version, 'composition v' + comp.version + ' on the timeline: ' + comp.shots.length + ' shots');
          }

          // latest attempt row per shot id
          function latestByShot(rows) {
            var m = {};
            (rows || []).forEach(function(r) {
              if (!m[r.shot_id] || r.attempt > m[r.shot_id].attempt) m[r.shot_id] = r;
            });
            return m;
          }

          function setThumb(container, url) {
            if (!url) return;
            var img = container.querySelector('img');
            if (img) {
              if (img.dataset.src !== url) { img.dataset.src = url; img.src = url; }
              return;
            }
            var empty = container.querySelector('.edl-thumb-empty, .chain-node-thumb');
            img = new Image();
            img.dataset.src = url;
            img.src = url;
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            if (empty && empty.classList.contains('edl-thumb-empty')) empty.remove();
            container.appendChild(img);
          }

          function fmtMetric(k, v) {
            if (typeof v !== 'number') return String(v);
            return v.toFixed(k === 'clipscore' || k === 'dino_drift' ? 3 : 2);
          }

          function updateShot(shotId, row) {
            var st = row.status;
            var cls = shotStateClass[st] || 'active';
            var lbl = shotStateLabel[st] || st;
            if (row.decision === 'retake') { cls = 'warn'; lbl = 'retaking'; }

            var block = edlStrip.querySelector('.edl-block[data-shot="' + shotId + '"]');
            if (block) {
              if (block.dataset.state !== cls) block.dataset.state = cls;
              var stateEl = block.querySelector('[data-state-label]');
              if (stateEl && stateEl.textContent !== lbl) stateEl.textContent = lbl;
              var thumbUrl = row.sheet_url || (row.frame_urls && row.frame_urls[0]) || null;
              if (thumbUrl) setThumb(block.querySelector('.edl-thumb'), thumbUrl);
              var scoreEl = block.querySelector('[data-score]');
              if (scoreEl && typeof row.score === 'number') scoreEl.textContent = row.score + '/24';
              if (row.attempt > 1 && !block.querySelector('.edl-attempt')) {
                var ab = document.createElement('span');
                ab.className = 'edl-attempt';
                block.appendChild(ab);
              }
              var att = block.querySelector('.edl-attempt');
              if (att) att.textContent = 'take ' + row.attempt;
              if (row.cached_from && !block.querySelector('.edl-cache')) {
                var cb = document.createElement('span');
                cb.className = 'edl-cache';
                cb.textContent = 'cached';
                cb.title = 'reused from ' + row.cached_from;
                block.appendChild(cb);
              }
            }

            var node = chainDag.querySelector('.chain-node[data-shot="' + shotId + '"]');
            if (node) {
              if (row.last_frame_url) setThumb(node, row.last_frame_url);
              node.dataset.state = cls;
            }

            var card = shotCards.querySelector('.shot-card[data-shot="' + shotId + '"]');
            if (!card) return;
            card.dataset.state = cls;
            var cState = card.querySelector('[data-card-state]');
            if (cState && cState.textContent !== lbl) cState.textContent = lbl;
            var cAttempt = card.querySelector('[data-card-attempt]');
            if (cAttempt) cAttempt.textContent = 'take ' + row.attempt + (row.cached_from ? ' \\u00b7 cached' : '');
            var cScore = card.querySelector('[data-card-score]');
            if (cScore && typeof row.score === 'number') cScore.textContent = row.score + '/24';
            if (row.prompt) {
              var cPrompt = card.querySelector('[data-card-prompt]');
              if (cPrompt && cPrompt.textContent !== row.prompt) cPrompt.textContent = row.prompt;
            }

            if (row.video_url) {
              var vWrap = card.querySelector('[data-card-video]');
              if (vWrap && vWrap.hidden) {
                vWrap.hidden = false;
                var v = document.createElement('video');
                v.controls = true; v.playsInline = true; v.preload = 'metadata';
                v.src = row.video_url;
                vWrap.appendChild(v);
              }
            }

            if (row.eval && (row.eval.gates || row.eval.metrics)) {
              var g = card.querySelector('[data-card-gates]');
              if (g) {
                g.hidden = false;
                g.innerHTML = '';
                (row.eval.gates || []).forEach(function(gate){
                  var chip = document.createElement('span');
                  chip.className = 'gate-chip';
                  chip.dataset.state = gate.passed === true ? 'pass' : gate.passed === false ? 'fail' : 'pending';
                  var nm = document.createElement('span');
                  nm.className = 'gate-name';
                  nm.textContent = (gate.name || '').replace(/_/g, ' ');
                  chip.appendChild(nm);
                  if (gate.value !== undefined && gate.value !== null) {
                    var val = document.createElement('span');
                    val.className = 'gate-val';
                    val.textContent = String(gate.value);
                    chip.appendChild(val);
                  }
                  g.appendChild(chip);
                });
                var metrics = row.eval.metrics || {};
                Object.keys(metrics).forEach(function(k){
                  var m = metrics[k];
                  if (!m || !m.summary) return;
                  var chip = document.createElement('span');
                  chip.className = 'gate-chip gate-chip-metric';
                  var nm = document.createElement('span');
                  nm.className = 'gate-name';
                  nm.textContent = k.replace(/_/g, ' ');
                  chip.appendChild(nm);
                  var val = document.createElement('span');
                  val.className = 'gate-val';
                  val.textContent = fmtMetric(k, m.summary.mean);
                  chip.appendChild(val);
                  g.appendChild(chip);
                });
              }
            }

            if (row.judge && row.judge.axes) {
              var grid = card.querySelector('[data-card-axes]');
              if (grid) {
                grid.hidden = false;
                renderAxes(grid, row.judge);
              }
            }

            var noteEl = card.querySelector('[data-card-note]');
            if (noteEl) {
              var noteText = '';
              if (row.judge && row.judge.retake_advice && row.decision === 'retake') noteText = 'Retake advice: ' + row.judge.retake_advice;
              else if (row.failure_reason) noteText = row.failure_reason;
              if (noteText) { noteEl.hidden = false; if (noteEl.textContent !== noteText) noteEl.textContent = noteText; }
            }
          }

          function levelClass(level) {
            return ['excellent','good','fair','poor','bad'].indexOf(level) >= 0 ? level : '';
          }

          function renderAxes(grid, judge) {
            Object.keys(judge.axes || {}).forEach(function(k){
              var row = grid.querySelector('[data-axis="' + k + '"]');
              if (!row) return;
              var a = judge.axes[k] || {};
              row.dataset.level = levelClass(a.level);
              var lbl = row.querySelector('[data-level-label]');
              if (lbl) lbl.textContent = a.level || '—';
              var rat = row.querySelector('[data-rationale]');
              if (rat) rat.textContent = a.rationale || '';
            });
          }

          function seamQuality(c) { return c > 0.8 ? 'ok' : c >= 0.6 ? 'warn' : 'bad'; }

          function renderSeams(comp) {
            var seams = comp && comp.assembly && comp.assembly.seams;
            if (!Array.isArray(seams) || !seams.length) return;
            var trByAfter = {};
            (comp.transitions || []).forEach(function(t){ trByAfter[t.after] = t; });
            edlSeams.hidden = false;
            edlSeams.innerHTML = '';
            seams.forEach(function(seam){
              var el = document.createElement('span');
              el.className = 'edl-seam';
              el.dataset.q = seamQuality(seam.dino_cosine);
              var dot = document.createElement('span');
              dot.className = 'edl-seam-dot';
              el.appendChild(dot);
              var t = trByAfter[seam.after];
              var lbl = document.createElement('span');
              lbl.textContent = 'after ' + seam.after + (t && t.type === 'xfade' ? ' (xfade)' : '') + ' \\u00b7 ' + seam.dino_cosine.toFixed(3);
              el.appendChild(lbl);
              edlSeams.appendChild(el);
            });
            var hint = document.createElement('span');
            hint.className = 'edl-seams-hint cut-hint';
            hint.textContent = 'Seam coherence: DINO cosine between the frames either side of each junction. Green above 0.8, amber 0.6\\u20130.8, red below.';
            edlSeams.appendChild(hint);
          }

          function renderFinal(s) {
            if (s.status !== 'stitching' && s.status !== 'judging' && s.status !== 'completed' && s.status !== 'failed') return;
            if (s.status === 'failed') return;
            finalWrap.hidden = false;
            if (s.status === 'stitching') {
              finalProgress.hidden = false;
              finalProgress.textContent = 'Assembling: normalize \\u2192 concat/xfade \\u2192 seam sheet. The engine is splicing the accepted shots into one timeline.';
            } else if (s.status === 'judging') {
              finalProgress.hidden = false;
              finalProgress.textContent = 'The final judge is reading the whole sequence: seven axes, including continuity across every cut.';
            } else {
              finalProgress.hidden = true;
            }
            if (s.final_url && finalPlayerWrap.hidden) {
              finalPlayerWrap.hidden = false;
              finalPlayer.src = s.final_url;
            }
            if (s.final_sheet_url || s.seam_sheet_url) {
              finalSheets.hidden = false;
              if (s.final_sheet_url && finalSheetImg.dataset.src !== s.final_sheet_url) { finalSheetImg.dataset.src = s.final_sheet_url; finalSheetImg.src = s.final_sheet_url; }
              if (s.seam_sheet_url && seamSheetImg.dataset.src !== s.seam_sheet_url) { seamSheetImg.dataset.src = s.seam_sheet_url; seamSheetImg.src = s.seam_sheet_url; }
            }
            if (s.judge && s.judge.axes) {
              finalAxisGrid.hidden = false;
              renderAxes(finalAxisGrid, s.judge);
              if (s.judge.summary) {
                finalJudgeSummary.hidden = false;
                finalJudgeSummary.textContent = s.judge.summary;
              }
            }
            if (s.status === 'completed' && s.slug) {
              finalLinkRow.hidden = false;
              finalLink.href = '/cut/' + s.slug + '/';
              var label = 'Open the finished piece';
              if (typeof s.final_score === 'number') label += ' \\u00b7 ' + s.final_score + '/28';
              finalLink.textContent = label;
            }
          }

          function applySnapshot(s) {
            if (!s || !s.ok) return;
            if (s.status !== lastStatus) {
              logLine('status: ' + lastStatus + ' \\u2192 ' + s.status);
              lastStatus = s.status;
              statusLabel.textContent = humanStatus(s.status);
              var n = narrationFor(s.status);
              narrate(n[0], n[1]);
            }
            if (s.current_version !== lastVersion) {
              lastVersion = s.current_version;
              versionLabel.textContent = 'v' + s.current_version;
              logLine('new composition version v' + s.current_version);
            }
            if (typeof s.cost_usd === 'number') costLabel.textContent = '$' + s.cost_usd.toFixed(3);
            if (s.revision_round > 0 && revisionLabel) {
              revisionLabel.hidden = false;
              revisionLabel.textContent = '';
              var dot = document.createElement('span');
              dot.className = 'reader-dot';
              dot.textContent = '\\u00b7';
              revisionLabel.appendChild(dot);
              revisionLabel.appendChild(document.createTextNode('revision ' + s.revision_round + ' of 5'));
            }
            if (s.title && pieceTitle.textContent !== s.title) pieceTitle.textContent = s.title;

            ensureComposition(s.composition);
            renderSeams(s.composition);

            var latest = latestByShot(s.shots);
            Object.keys(latest).forEach(function(shotId){ updateShot(shotId, latest[shotId]); });

            renderFinal(s);

            if (s.status === 'failed') {
              done = true;
              narrate('The pipeline hit a wall', 'A hard failure or exhausted budget. The issues section has the trail.');
              if (s.note && errorsWrap && errorsPre && s.note !== lastErrorLog) {
                errorsPre.textContent = s.note;
                errorsWrap.hidden = false;
                lastErrorLog = s.note;
              }
              logLine('piece failed');
            }
            if (s.status === 'completed' && s.slug) {
              done = true;
              logLine('final cut accepted \\u2014 redirecting to the finished piece');
              setTimeout(function(){ location.href = '/cut/' + s.slug + '/'; }, 1800);
            }
          }

          async function poll() {
            if (done) return;
            try {
              var r = await fetch('/api/cut/status/' + encodeURIComponent(id), { headers: { Accept: 'application/json' } });
              if (!r.ok) {
                consecutiveErrors++;
                if (consecutiveErrors < 3) logLine('status fetch returned ' + r.status);
                pollInterval = Math.min(20000, pollInterval * 1.4);
              } else {
                consecutiveErrors = 0;
                pollInterval = 3500;
                var json = await r.json();
                applySnapshot(json);
              }
            } catch (e) {
              consecutiveErrors++;
              if (consecutiveErrors < 3) logLine('network error, retrying');
            }
            if (!done) setTimeout(poll, pollInterval);
          }

          // ---- SSE: the live director feed ----
          var es = null;
          function setDot(state) { if (agentDot) agentDot.setAttribute('data-state', state); }
          function parseData(e) { try { return JSON.parse(e.data); } catch (err) { return {}; } }

          function startJudgeStream(label) {
            judgeStreamText = '';
            judgeStream.hidden = false;
            judgeStream.textContent = '';
            judgeContext.textContent = label;
          }
          function appendJudgeToken(text) {
            if (typeof text !== 'string') return;
            if (judgeStream.hidden) judgeStream.hidden = false;
            judgeStreamText += text;
            if (judgeStreamText.length > 12000) judgeStreamText = judgeStreamText.slice(-12000);
            judgeStream.textContent = judgeStreamText;
            judgeStream.scrollTop = judgeStream.scrollHeight;
          }

          function startStream() {
            if (done || typeof EventSource === 'undefined') return;
            es = new EventSource('/api/cut/stream/' + encodeURIComponent(id));
            es.addEventListener('hello', function(){
              setDot('live');
              logLine('connected to the live director stream');
            });
            es.addEventListener('plan_start', function(e){
              var d = parseData(e);
              logLine('director planning ' + (d.shot_count || '?') + ' shots');
            });
            es.addEventListener('plan_done', function(e){
              var d = parseData(e);
              logLine('shot list written: ' + (d.shots || '?') + ' shots' + (d.title ? ' \\u2014 \\u201c' + d.title + '\\u201d' : ''));
            });
            es.addEventListener('plan_error', function(e){
              logLine('plan error: ' + (parseData(e).message || 'unknown'));
            });
            es.addEventListener('compose_start', function(e){
              var d = parseData(e);
              logLine('composing ' + (d.shot || '?') + ' (take ' + (d.attempt || '?') + ')');
            });
            es.addEventListener('compose_done', function(e){
              var d = parseData(e);
              logLine((d.shot || '?') + ' composed \\u2014 submitting to ray-3.2');
              if (d.shot && d.prompt) {
                var card = shotCards.querySelector('.shot-card[data-shot="' + d.shot + '"]');
                if (card) {
                  var p = card.querySelector('[data-card-prompt]');
                  if (p) p.textContent = d.prompt;
                }
              }
            });
            es.addEventListener('compose_error', function(e){
              var d = parseData(e);
              logLine('compose error on ' + (d.shot || '?') + ': ' + (d.message || 'unknown'));
            });
            es.addEventListener('eval', function(e){
              var rec = parseData(e);
              var stage = rec.stage, ev = rec.event, d = rec.data || {};
              if (ev === 'stage_start' && stage === 'gates') logOnce('gates:' + rec.shot + ':' + rec.attempt, 'gates running on ' + rec.shot);
              else if (ev === 'stage_done' && (stage === 'flicker' || stage === 'flow' || stage === 'clipscore' || stage === 'dino_drift')) {
                logLine(rec.shot + ' ' + stage + ': mean ' + (typeof d.mean === 'number' ? d.mean.toFixed(3) : '?'));
              }
              else if (ev === 'gate' && d.passed === false) logLine('GATE FAILED on ' + rec.shot + ': ' + (d.name || '?'));
              else if (ev === 'results') logLine(rec.shot + ' measured in ' + (typeof d.elapsed_s === 'number' ? d.elapsed_s.toFixed(1) : '?') + 's');
              else if (ev === 'stage_fail') logLine('eval stage failed on ' + rec.shot + ': ' + stage + (d.reason ? ' \\u2014 ' + d.reason : ''));
            });
            es.addEventListener('stitch', function(e){
              var rec = parseData(e);
              var stage = rec.stage, ev = rec.event, d = rec.data || {};
              if (ev === 'stage_start' && stage === 'download') logLine('stitch: pulling ' + (d.count || '?') + ' accepted shots');
              else if (ev === 'stage_progress' && stage === 'download') logLine('stitch: ' + (d.shot || '?') + ' downloaded');
              else if (ev === 'stage_done' && stage === 'stitch_job') logLine('stitch complete \\u2014 seam sheet photographed');
              else if (ev === 'stage_fail') logLine('stitch failed: ' + (d.reason || stage));
            });
            es.addEventListener('judge_start', function(e){
              var d = parseData(e);
              startJudgeStream('Judging ' + (d.shot || 'shot') + ', take ' + (d.attempt || '?') + ' \\u00b7 six axes');
              logLine('judge reading ' + (d.shot || '?') + ' contact sheet');
            });
            es.addEventListener('judge_token', function(e){
              appendJudgeToken(parseData(e).text);
            });
            es.addEventListener('judge_done', function(e){
              var d = parseData(e);
              if (d.shot) {
                var card = shotCards.querySelector('.shot-card[data-shot="' + d.shot + '"]');
                if (card && d.axes) {
                  var grid = card.querySelector('[data-card-axes]');
                  if (grid) { grid.hidden = false; renderAxes(grid, d); }
                }
                logLine('verdict in on ' + d.shot);
              }
            });
            es.addEventListener('judge_error', function(e){
              logLine('judge error: ' + (parseData(e).message || 'unknown'));
            });
            es.addEventListener('final_judge_start', function(){
              startJudgeStream('Final judge \\u00b7 seven axes including continuity');
              logLine('final judge reading the sequence');
            });
            es.addEventListener('final_judge_done', function(e){
              var d = parseData(e);
              if (d.axes) {
                finalWrap.hidden = false;
                finalAxisGrid.hidden = false;
                renderAxes(finalAxisGrid, d);
                if (d.summary) { finalJudgeSummary.hidden = false; finalJudgeSummary.textContent = d.summary; }
              }
              logLine('final verdict in' + (d.repair_shot ? ' \\u2014 repair requested on ' + d.repair_shot : ''));
            });
            es.addEventListener('final_judge_error', function(e){
              logLine('final judge error: ' + (parseData(e).message || 'unknown'));
            });
            es.addEventListener('edit_route_start', function(){
              logLine('director routing an edit note');
            });
            es.addEventListener('edit_route_done', function(){
              logLine('edit routed \\u2014 re-cutting');
            });
            es.addEventListener('edit_route_error', function(e){
              logLine('edit routing error: ' + (parseData(e).message || 'unknown'));
            });
            es.onerror = function(){ setDot('reconnecting'); };
          }

          var humanStatusMap = {
            queued: 'Queued', planning: 'Planning', shooting: 'Shooting',
            stitching: 'Stitching', judging: 'Final judging', revising: 'Routing an edit',
            completed: 'Complete', failed: 'Failed'
          };
          function humanStatus(s) { return humanStatusMap[s] || s || 'Working'; }

          var n0 = narrationFor(lastStatus);
          narrate(n0[0], n0[1]);
          statusLabel.textContent = humanStatus(lastStatus);
          startStream();
          window.addEventListener('beforeunload', function(){ if (es) es.close(); });
          poll();
        })();
      </script>
    `,
  });
}

function humanStatusSSR(s: string): string {
  const map: Record<string, string> = {
    queued: "Queued",
    planning: "Planning",
    shooting: "Shooting",
    stitching: "Stitching",
    judging: "Final judging",
    revising: "Routing an edit",
    completed: "Complete",
    failed: "Failed",
  };
  return map[s] ?? s;
}

function derivedTitle(prompt: string): string {
  const t = prompt.trim().replace(/\s+/g, " ");
  return t.length > 72 ? `${t.slice(0, 69)}...` : t || "Untitled cut";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type ShellOpts = { title: string; canonical: string; description: string; bodyHtml: string };

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
  <meta name="robots" content="noindex,nofollow" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;1,9..144,400;1,9..144,500&family=JetBrains+Mono:wght@400;500&display=swap"
    rel="stylesheet"
  />
  <style>${STUDIO_CSS}</style>
</head>
<body class="cut-studio">
  <nav class="reader-bar" aria-label="Site">
    <a class="reader-bar-brand" href="/">Truffle</a>
    <a class="reader-bar-link" href="/cut/">Cut</a>
    <a class="reader-bar-link" href="/cut/learn/">How the cut works</a>
  </nav>
  ${opts.bodyHtml}
</body>
</html>`;
}

// Filmic identity shared with the reader page: deep slate paper, amber
// highlights on the timeline. The EDL strip reads like an NLE timeline.
const STUDIO_CSS = `
  :root {
    --slate: #10141b; --slate-2: #161c25; --slate-3: #1e2632;
    --ink: #ece7da; --ink-2: #c2bba9; --ink-3: #8b8775;
    --line: #2a3340;
    --amber: #e2a33c; --amber-2: #c4882a;
    --ok: #5cb585; --warn: #d4ad45; --bad: #d97a7a;
    --font-serif: "Fraunces", Georgia, serif;
    --font-sans: "Inter", system-ui, sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, monospace;
    --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
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

  .studio-page { max-width: 1240px; margin: 0 auto; padding: 44px 24px 96px; }
  .reader-eyebrow {
    margin: 0 0 12px; font-family: var(--font-mono); font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.14em;
  }
  .reader-eyebrow a { color: var(--ink-3); text-decoration: none; }
  .reader-eyebrow a:hover { color: var(--amber); }
  .reader-title {
    font-family: var(--font-serif); font-weight: 400;
    font-size: clamp(26px, 4vw, 40px); line-height: 1.12; letter-spacing: -0.01em; margin: 0 0 14px;
  }
  .reader-meta {
    font-family: var(--font-mono); font-size: 12px; color: var(--ink-3);
    margin: 0 0 28px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px;
    font-variant-numeric: tabular-nums;
  }
  .reader-dot { margin: 0 4px; }
  .reader-h2 { font-family: var(--font-serif); font-weight: 400; font-size: 23px; margin: 40px 0 12px; }
  .reader-h2-aside { font-family: var(--font-mono); font-size: 11px; color: var(--ink-3); letter-spacing: 0.06em; margin-left: 10px; text-transform: uppercase; }
  .reader-body { color: var(--ink-2); font-size: 14.5px; max-width: 70ch; }
  .reader-detail-block { margin-top: 8px; }
  .cut-hint { color: var(--ink-3); font-size: 13.5px; max-width: 66ch; margin: 0 0 14px; }
  .cut-hint a { color: var(--amber); }
  .draft-status { color: var(--amber); font-weight: 500; position: relative; padding-left: 16px; }
  .draft-status::before {
    content: ''; position: absolute; left: 0; top: 50%; width: 8px; height: 8px;
    background: var(--amber); border-radius: 999px; transform: translateY(-50%);
    animation: pulse 1.2s ease-in-out infinite alternate;
  }
  @keyframes pulse {
    from { opacity: 0.35; transform: translateY(-50%) scale(0.85); }
    to   { opacity: 1; transform: translateY(-50%) scale(1.1); }
  }

  .draft-narration {
    margin: 0 0 32px; padding: 22px 24px 18px;
    border: 1px solid var(--line); border-radius: 14px;
    background: linear-gradient(180deg, color-mix(in oklab, var(--amber) 7%, var(--slate-2)) 0%, var(--slate-2) 65%);
    position: relative;
  }
  .draft-narration::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
    background: var(--amber); border-top-left-radius: 14px; border-bottom-left-radius: 14px;
  }
  .draft-narration-eyebrow {
    margin: 0 0 6px; font-family: var(--font-mono); font-size: 10.5px;
    text-transform: uppercase; letter-spacing: 0.18em; color: var(--amber);
  }
  .draft-narration-title {
    margin: 0 0 8px; font-family: var(--font-serif); font-weight: 400; font-style: italic;
    font-size: clamp(20px, 2.6vw, 26px); line-height: 1.25;
    display: flex; align-items: baseline; gap: 4px; flex-wrap: wrap;
  }
  .draft-narration-cursor {
    display: inline-block; width: 2px; height: 1em; background: var(--amber);
    transform: translateY(2px); animation: blink 1.05s steps(2, end) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  .draft-narration-body { margin: 0; color: var(--ink-2); font-size: 14.5px; line-height: 1.55; max-width: 70ch; }

  .studio-grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 32px; align-items: start; }
  @media (max-width: 980px) { .studio-grid { grid-template-columns: 1fr; } }
  .studio-rail { position: sticky; top: 18px; display: flex; flex-direction: column; gap: 8px; }
  @media (max-width: 980px) { .studio-rail { position: static; } }
  .rail-h {
    margin: 32px 0 8px; font-family: var(--font-mono); font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink-3); font-weight: 500;
  }
  .studio-rail section:first-child .rail-h { margin-top: 40px; }
  .rail-hint { color: var(--ink-3); font-size: 12px; margin: 0 0 10px; }

  /* EDL strip: read like an NLE timeline */
  .edl-strip {
    display: flex; align-items: stretch; gap: 0;
    border: 1px solid var(--line); border-radius: 12px;
    background: var(--slate-2); padding: 14px 14px 12px; overflow-x: auto;
  }
  .edl-block {
    flex: 1 1 0; min-width: 108px; position: relative;
    border-top: 3px solid var(--ink-3); background: var(--slate-3);
    border-radius: 6px; padding: 8px 10px 8px; margin: 0 2px;
    transition: border-color 0.4s var(--ease-out);
  }
  .edl-block[data-state="active"] { border-top-color: var(--amber); }
  .edl-block[data-state="done"] { border-top-color: var(--ok); }
  .edl-block[data-state="warn"] { border-top-color: var(--warn); }
  .edl-block[data-state="fail"] { border-top-color: var(--bad); }
  .edl-thumb {
    width: 100%; aspect-ratio: 16 / 9; border-radius: 4px; overflow: hidden;
    background: #000; margin-bottom: 8px; position: relative;
    display: flex; align-items: center; justify-content: center;
  }
  .edl-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .edl-thumb-empty { font-family: var(--font-mono); font-size: 12px; color: var(--ink-3); }
  .edl-block[data-state="active"] .edl-thumb:empty,
  .edl-block[data-state="active"] .edl-thumb:has(.edl-thumb-empty) {
    background: linear-gradient(110deg, #000 8%, var(--slate-2) 18%, #000 33%);
    background-size: 200% 100%;
    animation: shimmer 1.4s linear infinite;
  }
  @keyframes shimmer { to { background-position-x: -200%; } }
  .edl-block-meta {
    display: flex; align-items: baseline; gap: 8px;
    font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums;
  }
  .edl-id { color: var(--amber); text-decoration: none; font-weight: 500; font-family: var(--font-mono); }
  .edl-id:hover { text-decoration: underline; }
  .edl-dur { font-family: var(--font-mono); }
  .edl-state { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
  .edl-block[data-state="active"] .edl-state { color: var(--amber); }
  .edl-block[data-state="done"] .edl-state { color: var(--ok); }
  .edl-block[data-state="warn"] .edl-state { color: var(--warn); }
  .edl-block[data-state="fail"] .edl-state { color: var(--bad); }
  .edl-score { margin-left: auto; color: var(--ink-2); font-family: var(--font-mono); font-size: 10.5px; }
  .edl-attempt {
    position: absolute; top: 8px; left: 8px;
    font-size: 9.5px; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em;
    background: color-mix(in oklab, var(--warn) 18%, var(--slate-3));
    border: 1px solid color-mix(in oklab, var(--warn) 45%, var(--line));
    color: var(--warn); border-radius: 999px; padding: 1px 7px;
  }
  .edl-cache {
    position: absolute; top: 8px; right: 8px;
    font-size: 9.5px; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em;
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
  .edl-tr-label { font-size: 9.5px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--font-mono); }

  .edl-seams { display: flex; flex-wrap: wrap; gap: 14px; align-items: baseline; margin: 12px 2px 0; }
  .edl-seam { display: inline-flex; align-items: baseline; gap: 7px; font-size: 12px; color: var(--ink-2); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .edl-seam-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; transform: translateY(1px); }
  .edl-seam[data-q="ok"] .edl-seam-dot { background: var(--ok); }
  .edl-seam[data-q="warn"] .edl-seam-dot { background: var(--warn); }
  .edl-seam[data-q="bad"] .edl-seam-dot { background: var(--bad); }
  .edl-seams-hint { flex-basis: 100%; margin: 4px 0 0; }

  /* chain DAG */
  .chain-dag {
    display: flex; align-items: center; gap: 0; flex-wrap: wrap;
    border: 1px solid var(--line); border-radius: 12px;
    background: var(--slate-2); padding: 18px 20px; min-height: 84px;
  }
  .chain-empty { font-size: 12.5px; color: var(--ink-3); }
  .chain-node { display: inline-flex; flex-direction: column; align-items: center; gap: 4px; }
  .chain-node-thumb {
    width: 56px; height: 56px; border-radius: 50%; overflow: hidden;
    border: 2px solid var(--ink-3); background: #000;
    display: inline-flex; align-items: center; justify-content: center;
    font-family: var(--font-mono); font-size: 11px; color: var(--ink-3);
    position: relative;
  }
  .chain-node img {
    width: 56px; height: 56px; border-radius: 50%; object-fit: cover; display: block;
    border: 2px solid var(--ink-3);
  }
  .chain-node[data-state="active"] .chain-node-thumb, .chain-node[data-state="active"] img { border-color: var(--amber); }
  .chain-node[data-state="done"] .chain-node-thumb, .chain-node[data-state="done"] img { border-color: var(--ok); }
  .chain-node[data-state="warn"] .chain-node-thumb, .chain-node[data-state="warn"] img { border-color: var(--warn); }
  .chain-node[data-state="fail"] .chain-node-thumb, .chain-node[data-state="fail"] img { border-color: var(--bad); }
  .chain-node img + .chain-node-thumb { display: none; }
  .chain-edge {
    display: inline-flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 0 6px; min-width: 72px; position: relative;
  }
  .chain-edge::before {
    content: ''; display: block; width: 100%; height: 2px;
    background: var(--amber); opacity: 0.7;
  }
  .chain-edge::after {
    content: ''; position: absolute; right: 4px; top: -3px;
    border: 4px solid transparent; border-left-color: var(--amber); opacity: 0.7;
  }
  .chain-edge[data-kind="free"]::before { background: var(--ink-3); }
  .chain-edge[data-kind="free"]::after { border-left-color: var(--ink-3); }
  .chain-edge-label { font-family: var(--font-mono); font-size: 9.5px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.05em; }

  /* shot cards */
  .shot-card {
    border: 1px solid var(--line); border-left: 3px solid var(--ink-3);
    border-radius: 10px; padding: 16px 20px; background: var(--slate-2); margin-bottom: 14px;
    transition: border-color 0.4s var(--ease-out);
  }
  .shot-card[data-state="active"] { border-left-color: var(--amber); }
  .shot-card[data-state="done"] { border-left-color: var(--ok); }
  .shot-card[data-state="warn"] { border-left-color: var(--warn); }
  .shot-card[data-state="fail"] { border-left-color: var(--bad); }
  .shot-card-head {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 8px;
    font-family: var(--font-mono); font-size: 12px;
  }
  .shot-card-id { color: var(--amber); font-weight: 600; font-size: 13px; }
  .shot-card-state { text-transform: uppercase; letter-spacing: 0.06em; font-size: 10.5px; color: var(--ink-3); }
  .shot-card[data-state="active"] .shot-card-state { color: var(--amber); }
  .shot-card[data-state="done"] .shot-card-state { color: var(--ok); }
  .shot-card[data-state="warn"] .shot-card-state { color: var(--warn); }
  .shot-card[data-state="fail"] .shot-card-state { color: var(--bad); }
  .shot-card-attempt { color: var(--ink-3); font-size: 11px; }
  .shot-card-score { margin-left: auto; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .shot-card-prompt { color: var(--ink-2); font-size: 13.5px; margin: 0 0 12px; max-width: 78ch; }
  .shot-card-video { margin: 0 0 12px; }
  .shot-card-video video {
    width: 100%; max-width: 560px; border-radius: 10px;
    border: 1px solid var(--line); background: #000; display: block;
  }
  .shot-card-gates { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
  .gate-chip {
    display: inline-flex; align-items: baseline; gap: 7px;
    border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px;
    font-family: var(--font-mono); font-size: 11px; background: var(--slate-3);
    font-variant-numeric: tabular-nums;
  }
  .gate-chip[data-state="pass"] { border-color: color-mix(in oklab, var(--ok) 50%, var(--line)); }
  .gate-chip[data-state="pass"] .gate-name::before { content: '\\2713 '; color: var(--ok); }
  .gate-chip[data-state="fail"] { border-color: var(--bad); background: color-mix(in oklab, var(--bad) 8%, var(--slate-3)); }
  .gate-chip[data-state="fail"] .gate-name::before { content: '\\2717 '; color: var(--bad); }
  .gate-chip-metric { border-style: dashed; }
  .gate-name { color: var(--ink-2); }
  .gate-val { color: var(--ink-3); }
  .shot-card-note { color: var(--warn); font-size: 12.5px; margin: 0; }
  .shot-card[data-state="fail"] .shot-card-note { color: var(--bad); }

  /* axes */
  .axis-grid { display: flex; flex-direction: column; gap: 0; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .axis-row {
    display: grid; grid-template-columns: 110px 86px 1fr; gap: 12px;
    padding: 9px 16px; border-bottom: 1px solid var(--line); background: var(--slate-3);
    font-size: 13px; align-items: baseline;
  }
  .axis-row:last-child { border-bottom: none; }
  .axis-name { font-family: var(--font-mono); font-size: 12px; color: var(--ink-2); }
  .axis-level { font-family: var(--font-mono); font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
  .axis-row[data-level="excellent"] .axis-level { color: var(--ok); }
  .axis-row[data-level="good"] .axis-level { color: var(--ok); opacity: 0.85; }
  .axis-row[data-level="fair"] .axis-level { color: var(--warn); }
  .axis-row[data-level="poor"] .axis-level, .axis-row[data-level="bad"] .axis-level { color: var(--bad); }
  .axis-rationale { color: var(--ink-3); font-size: 12.5px; line-height: 1.5; }
  @media (max-width: 640px) {
    .axis-row { grid-template-columns: 90px 70px; }
    .axis-rationale { grid-column: 1 / -1; }
  }
  .judge-summary { margin: 14px 0 0; color: var(--ink-2); font-size: 14px; max-width: 70ch; font-style: italic; }

  /* final act */
  .cut-player-wrap { margin: 0 0 14px; }
  .cut-player {
    width: 100%; border-radius: 14px; border: 1px solid var(--line);
    background: #000; display: block;
  }
  .final-sheets { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 0 0 14px; }
  @media (max-width: 760px) { .final-sheets { grid-template-columns: 1fr; } }
  .final-sheet-fig { margin: 0; }
  .final-sheet-fig img { width: 100%; border-radius: 10px; border: 1px solid var(--line); display: block; background: #000; }
  .final-sheet-fig figcaption { font-family: var(--font-mono); font-size: 11px; color: var(--ink-3); margin-top: 6px; }

  /* rail: judge stream + log */
  .draft-agent-dot {
    display: inline-block; width: 9px; height: 9px; border-radius: 999px;
    background: var(--ink-3); vertical-align: middle; margin-left: 4px;
  }
  .draft-agent-dot[data-state="live"] { background: var(--ok); animation: pulse2 1.2s ease-in-out infinite alternate; }
  .draft-agent-dot[data-state="reconnecting"] { background: var(--warn); }
  @keyframes pulse2 { from { opacity: 0.45; } to { opacity: 1; } }
  .judge-stream {
    max-height: 300px; overflow-y: auto; margin: 0 0 8px;
    border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px;
    background: var(--slate-2); font-family: var(--font-mono); font-size: 11.5px;
    line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: var(--ink-2);
  }
  .draft-log {
    list-style: none; margin: 0; padding: 12px 14px;
    border: 1px solid var(--line); border-radius: 10px; background: var(--slate-2);
    font-family: var(--font-mono); font-size: 11.5px; line-height: 1.7;
    max-height: 420px; overflow-y: auto; color: var(--ink-2);
  }
  .draft-log-when { color: var(--ink-3); margin-right: 6px; font-size: 10.5px; }
  .draft-errors-pre {
    border: 1px solid color-mix(in oklab, var(--bad) 35%, var(--line));
    border-radius: 10px; background: color-mix(in oklab, var(--bad) 4%, var(--slate-2));
    padding: 14px 16px; font-family: var(--font-mono); font-size: 11.5px;
    white-space: pre-wrap; word-break: break-word; color: var(--ink-2);
    max-height: 220px; overflow-y: auto;
  }

  .cut-btn {
    display: inline-block; padding: 10px 22px; border-radius: 999px;
    font-size: 14px; text-decoration: none; border: 1px solid var(--line); color: var(--ink);
  }
  .cut-btn-primary { background: var(--amber); border-color: var(--amber); color: #10141b; font-weight: 600; }
`;
