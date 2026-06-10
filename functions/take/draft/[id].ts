// GET /take/draft/<id>/
// Live view for a Take piece moving through the eval cascade.
// The page does two jobs at once:
//   1. Drives the pipeline. /api/take/status/<id> advances the state machine
//      one bounded step per poll, so the poll loop here IS the heartbeat.
//   2. Shows the cascade live. SSE from /api/take/stream/<id> relays the
//      bridge channel: compose reasoning, engine stage events (gates, frames,
//      CV lanes), and judge tokens as Claude writes the verdict.
//
// Redirects to the reader view (/take/<slug>/) once the piece completes.

import { type TakeEnv, PIECE_ID_RE } from "../../_take-shared.ts";

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
  visible: number;
  error_log: string | null;
};

export const onRequestGet: PagesFunction<TakeEnv> = async (ctx) => {
  // Catch-all friendly: derive the id from the path, tolerate trailing slash.
  const url = new URL(ctx.request.url);
  const id = url.pathname.replace(/^\/take\/draft\//, "").replace(/\/+$/, "");
  if (!PIECE_ID_RE.test(id)) return notFound("That draft id doesn't look right.");

  let piece: PieceRow | null = null;
  try {
    piece = await ctx.env.DB.prepare(
      `SELECT id, slug, prompt_raw, prompt_enhanced, aspect_ratio, resolution,
              duration, status, current_attempt, max_attempts, visible, error_log
         FROM take_pieces WHERE id = ? LIMIT 1`,
    )
      .bind(id)
      .first<PieceRow>();
  } catch {
    piece = null;
  }
  if (!piece) return notFound("No take by that id. It may have been cleaned up.");

  if (piece.status === "completed" && piece.visible) {
    return Response.redirect(
      new URL(`/take/${encodeURIComponent(piece.slug)}/`, ctx.request.url).toString(),
      302,
    );
  }

  return new Response(renderDraft(piece), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, max-age=5",
    },
  });
};

function notFound(detail: string): Response {
  const html = renderShell({
    title: "Take · draft not found",
    canonical: "https://truffleagent.com/take/",
    description: "This Take draft is not available.",
    bodyHtml: `
      <main class="reader-page">
        <p class="reader-eyebrow"><a href="/take/">Back to Take</a></p>
        <h1 class="reader-title">Nothing in flight here.</h1>
        <p class="reader-lead">${escapeHtml(detail)}</p>
        <p><a class="take-btn take-btn-primary" href="/take/">Open the studio</a></p>
      </main>`,
  });
  return new Response(html, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
  });
}

const DAG_NODES = [
  { key: "compose", label: "Compose", sub: "agent writes the shot" },
  { key: "generate", label: "Generate", sub: "Luma ray-3.2" },
  { key: "ingest", label: "Ingest", sub: "video to storage" },
  { key: "gates", label: "L0 Gates", sub: "6 deterministic checks" },
  { key: "lanes", label: "L1 Lanes", sub: "4 CV metrics" },
  { key: "judge", label: "L2 Judge", sub: "VLM reads the sheet" },
  { key: "decision", label: "L3 Decision", sub: "accept or retake" },
] as const;

const LANES = [
  { key: "flicker", label: "flicker", hint: "frame-to-frame luma diff" },
  { key: "flow", label: "optical flow", hint: "Farneback motion magnitude" },
  { key: "clipscore", label: "CLIPScore", hint: "prompt-frame alignment" },
  { key: "dino_drift", label: "DINO drift", hint: "subject identity vs frame 0" },
] as const;

const AXES = ["fidelity", "aesthetics", "consistency", "motion", "semantics", "physics"] as const;

function renderDraft(piece: PieceRow): string {
  const title = derivedTitle(piece.prompt_raw);

  const dagHtml = DAG_NODES.map(
    (n, i) => `
      <li class="dag-node" data-node="${n.key}" data-state="pending">
        <span class="dag-dot" aria-hidden="true"></span>
        <span class="dag-label">${n.label}</span>
        <span class="dag-sub">${n.sub}</span>
        ${i < DAG_NODES.length - 1 ? '<span class="dag-link" aria-hidden="true"></span>' : ""}
      </li>`,
  ).join("");

  const laneHtml = LANES.map(
    (l) => `
      <div class="lane-chip" data-lane="${l.key}" data-state="pending" title="${l.hint}">
        <span class="lane-name">${l.label}</span>
        <span class="lane-val" data-val>—</span>
      </div>`,
  ).join("");

  const frameSlots = Array.from({ length: 10 }, (_, i) => i)
    .map(
      (i) => `
      <div class="take-frame-slot" data-i="${i}" data-state="empty">
        <span class="take-frame-time" data-time></span>
      </div>`,
    )
    .join("");

  const axisRows = AXES.map(
    (a) => `
      <div class="axis-row" data-axis="${a}" data-level="">
        <span class="axis-name">${a}</span>
        <span class="axis-level" data-level-label>—</span>
        <span class="axis-rationale" data-rationale></span>
      </div>`,
  ).join("");

  return renderShell({
    title: `Generating · ${title} · Take`,
    canonical: `https://truffleagent.com/take/draft/${piece.id}/`,
    description: `A Take clip is moving through the eval cascade. ${piece.resolution}, ${piece.duration}.`,
    bodyHtml: `
      <main class="reader-page">
        <header class="reader-head">
          <p class="reader-eyebrow"><a href="/take/">Take</a></p>
          <h1 class="reader-title">${escapeHtml(title)}</h1>
          <p class="reader-meta">
            <span class="draft-status" id="status-label">${escapeHtml(humanStatusSSR(piece.status))}</span>
            <span class="reader-dot">·</span>
            <span id="attempt-counter">attempt ${piece.current_attempt} of ${piece.max_attempts}</span>
            <span class="reader-dot">·</span>
            <span class="mono">${escapeHtml(piece.resolution)} / ${escapeHtml(piece.duration)} / ${escapeHtml(piece.aspect_ratio)}</span>
          </p>
        </header>

        <section class="draft-narration" aria-live="polite" aria-label="Live narration">
          <p class="draft-narration-eyebrow">The cascade · live</p>
          <h2 class="draft-narration-title"><span id="narration-headline">Waking the pipeline</span><span class="draft-narration-cursor" aria-hidden="true"></span></h2>
          <p class="draft-narration-body" id="narration-body">
            The agent is about to read your prompt and write the shot. Every stage below runs live, and every number you will see is a real measurement, not a progress bar.
          </p>
        </section>

        <section aria-label="Pipeline">
          <h2 class="reader-h2">The cascade</h2>
          <ol class="dag-rail" id="dag-rail">${dagHtml}</ol>

          <div class="dag-detail">
            <div class="dag-detail-block">
              <h3 class="dag-detail-h">L0 gates</h3>
              <div class="gate-chips" id="gate-chips">
                <span class="gate-empty" id="gate-empty">Waiting for the clip. Gates run the moment the video lands: decode, duration, resolution, framerate, not-black, not-frozen.</span>
              </div>
            </div>
            <div class="dag-detail-block">
              <h3 class="dag-detail-h">L1 lanes</h3>
              <div class="lane-chips">${laneHtml}</div>
            </div>
          </div>
        </section>

        <section aria-label="Sampled frames">
          <h2 class="reader-h2">Sampled frames <span class="reader-h2-aside" id="frames-aside">the judge will see exactly these</span></h2>
          <div class="take-frames" id="take-frames">${frameSlots}</div>
        </section>

        <section aria-label="Judge">
          <h2 class="reader-h2">The judge <span class="draft-agent-dot" id="agent-dot" title="stream status" aria-hidden="true"></span></h2>
          <p class="take-hint">When the lanes finish, Claude reads the timestamped contact sheet next to the deterministic readings and rules on six axes. The verdict streams here token by token.</p>
          <pre class="judge-stream" id="judge-stream" hidden></pre>
          <div class="axis-grid" id="axis-grid" hidden>${axisRows}</div>
          <p class="judge-summary" id="judge-summary" hidden></p>
        </section>

        <section aria-label="Attempt history" id="attempts-wrap" hidden>
          <h2 class="reader-h2">Attempts</h2>
          <ol class="attempt-list" id="attempt-list"></ol>
        </section>

        <section aria-label="Event log">
          <h2 class="reader-h2">Live log</h2>
          <ol class="draft-log" id="live-log">
            <li><span class="draft-log-when">just now</span> draft opened, driving the pipeline</li>
          </ol>
        </section>

        <section id="errors-wrap" aria-label="Pipeline issues"${piece.error_log ? "" : " hidden"}>
          <h2 class="reader-h2">Pipeline issues</h2>
          <p class="take-hint">Non-fatal errors the driver retried. Attempts usually recover on the next pass.</p>
          <pre class="draft-errors-pre" id="errors-pre">${piece.error_log ? escapeHtml(piece.error_log) : ""}</pre>
        </section>

        <section class="reader-detail">
          <div class="reader-detail-block">
            <h2 class="reader-h2">Your prompt</h2>
            <p class="reader-body">${escapeHtml(piece.prompt_raw)}</p>
          </div>
          <div class="reader-detail-block" id="enhanced-block"${piece.prompt_enhanced ? "" : " hidden"}>
            <h2 class="reader-h2">What the agent wrote</h2>
            <p class="reader-body" id="enhanced-body">${piece.prompt_enhanced ? escapeHtml(piece.prompt_enhanced) : ""}</p>
            <p class="take-hint" id="compose-reasoning"></p>
          </div>
        </section>
      </main>

      <script>
        (function(){
          var id = ${JSON.stringify(piece.id)};
          var done = false;
          var pollInterval = 4000;
          var consecutiveErrors = 0;
          var lastStatus = ${JSON.stringify(piece.status)};
          var lastAttempt = ${piece.current_attempt};
          var lastErrorLog = '';
          var renderedFrames = {};
          var judgeStreamText = '';
          var seenStages = {};

          var $ = function(s){ return document.getElementById(s); };
          var statusLabel = $('status-label');
          var attemptCounter = $('attempt-counter');
          var narrationHeadline = $('narration-headline');
          var narrationBody = $('narration-body');
          var dagRail = $('dag-rail');
          var gateChips = $('gate-chips');
          var gateEmpty = $('gate-empty');
          var framesRoot = $('take-frames');
          var judgeStream = $('judge-stream');
          var axisGrid = $('axis-grid');
          var judgeSummary = $('judge-summary');
          var liveLog = $('live-log');
          var errorsWrap = $('errors-wrap');
          var errorsPre = $('errors-pre');
          var attemptsWrap = $('attempts-wrap');
          var attemptList = $('attempt-list');
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
            while (liveLog.children.length > 80) liveLog.removeChild(liveLog.lastChild);
          }

          function setNode(key, state) {
            var n = dagRail.querySelector('[data-node="' + key + '"]');
            if (n && n.dataset.state !== state) n.dataset.state = state;
          }

          // Map piece status to coarse DAG states. SSE stage events refine
          // gates/lanes/judge below; this keeps the rail honest on reconnect.
          function paintDag(status) {
            var order = ['compose','generate','ingest','gates','lanes','judge','decision'];
            var activeIdx = {
              queued: 0, retaking: 0, composing: 0,
              generating: 1, ingesting: 2,
              evaluating: 3, judging: 5,
              completed: 7, failed: -1
            }[status];
            if (activeIdx === undefined) return;
            for (var i = 0; i < order.length; i++) {
              if (status === 'failed') { continue; }
              if (i < activeIdx) setNode(order[i], 'done');
              else if (i === activeIdx) setNode(order[i], 'active');
              else if (dagRail.querySelector('[data-node="' + order[i] + '"]').dataset.state !== 'done'
                       && dagRail.querySelector('[data-node="' + order[i] + '"]').dataset.state !== 'fail') {
                setNode(order[i], 'pending');
              }
            }
            if (status === 'evaluating') setNode('lanes', activeIdx >= 4 ? 'active' : dagRail.querySelector('[data-node="lanes"]').dataset.state);
            if (status === 'completed') { order.forEach(function(k){ setNode(k, 'done'); }); }
          }

          function resetForNewAttempt(n) {
            logLine('attempt ' + n + ' starting — composing a corrected shot');
            ['compose','generate','ingest','gates','lanes','judge','decision'].forEach(function(k){ setNode(k, 'pending'); });
            setNode('compose', 'active');
            if (gateChips) { gateChips.innerHTML = ''; gateChips.appendChild(gateEmpty); gateEmpty.hidden = false; }
            document.querySelectorAll('.lane-chip').forEach(function(c){
              c.dataset.state = 'pending';
              var v = c.querySelector('[data-val]'); if (v) v.textContent = '—';
            });
            document.querySelectorAll('.take-frame-slot').forEach(function(s){
              s.dataset.state = 'empty';
              var img = s.querySelector('img'); if (img) img.remove();
              var t = s.querySelector('[data-time]'); if (t) t.textContent = '';
            });
            renderedFrames = {};
            judgeStreamText = '';
            seenStages = {};
            if (judgeStream) { judgeStream.hidden = true; judgeStream.textContent = ''; }
            if (axisGrid) axisGrid.hidden = true;
            if (judgeSummary) judgeSummary.hidden = true;
          }

          function narrate(title, body) {
            if (narrationHeadline.textContent !== title) narrationHeadline.textContent = title;
            if (body && narrationBody.textContent !== body) narrationBody.textContent = body;
          }

          function narrationFor(status) {
            switch (status) {
              case 'queued': case 'composing':
                return ['Composing the shot', 'The agent reads your prompt and writes a director-grade brief for ray-3.2: subject, motion, camera, light. You will see exactly what it wrote.'];
              case 'retaking':
                return ['Composing a corrected shot', 'The last attempt was rejected. The agent has the failed gates, the lane readings, and the judge\\u2019s advice in hand, and is rewriting the prompt to fix what failed.'];
              case 'generating':
                return ['Ray-3.2 is rendering', 'The clip is generating on Luma. Typical wall time is 30 to 90 seconds. The cascade starts the instant the video lands.'];
              case 'ingesting':
                return ['Clip landed, moving to storage', 'Downloading the render and handing it to the eval engine.'];
              case 'evaluating':
                return ['The cascade is measuring', 'Six deterministic gates, then four CV lanes: flicker, optical flow, CLIPScore, DINO identity drift. Real measurements on every frame, before any model gives an opinion.'];
              case 'judging':
                return ['The judge is reading', 'Claude has the timestamped contact sheet and the lane readings side by side. It rules on six axes and must justify each level before naming it.'];
              case 'completed':
                return ['Accepted. Routing you to the clip.', 'The verdict is in and the clip passed. Redirecting to the finished piece with the full eval receipt.'];
              case 'failed':
                return ['The pipeline hit a wall', 'All attempts exhausted or a hard failure. The issues section below has the error tail.'];
              default:
                return ['Working', 'Status: ' + status];
            }
          }

          function levelClass(level) {
            return ['excellent','good','fair','poor','bad'].indexOf(level) >= 0 ? level : '';
          }

          function renderVerdict(judge) {
            if (!judge || !judge.axes) return;
            axisGrid.hidden = false;
            Object.keys(judge.axes).forEach(function(k){
              var row = axisGrid.querySelector('[data-axis="' + k + '"]');
              if (!row) return;
              var a = judge.axes[k] || {};
              row.dataset.level = levelClass(a.level);
              var lbl = row.querySelector('[data-level-label]');
              if (lbl) lbl.textContent = a.level || '—';
              var rat = row.querySelector('[data-rationale]');
              if (rat) rat.textContent = a.rationale || '';
            });
            if (judge.summary) {
              judgeSummary.hidden = false;
              judgeSummary.textContent = judge.summary;
            }
          }

          function renderAttempts(attempts) {
            if (!Array.isArray(attempts)) return;
            var decided = attempts.filter(function(a){ return a.decision; });
            if (!decided.length) return;
            attemptsWrap.hidden = false;
            attemptList.innerHTML = '';
            decided.forEach(function(a){
              var li = document.createElement('li');
              li.className = 'attempt-item';
              li.dataset.decision = a.decision;
              var head = document.createElement('span');
              head.className = 'attempt-head';
              head.textContent = 'Attempt ' + a.attempt_index + ' — ' + (a.decision === 'accept' ? 'accepted' : a.decision === 'retake' ? 'rejected, retaking' : 'rejected');
              li.appendChild(head);
              if (a.failure_reason) {
                var why = document.createElement('span');
                why.className = 'attempt-why';
                why.textContent = a.failure_reason;
                li.appendChild(why);
              }
              attemptList.appendChild(li);
            });
          }

          function renderFrameUrls(urls) {
            if (!Array.isArray(urls)) return;
            for (var i = 0; i < urls.length && i < 10; i++) {
              var slot = framesRoot.querySelector('.take-frame-slot[data-i="' + i + '"]');
              if (!slot || slot.querySelector('img')) continue;
              var img = new Image();
              img.src = urls[i];
              img.alt = 'Sampled frame ' + (i + 1);
              img.loading = 'lazy';
              img.decoding = 'async';
              slot.appendChild(img);
              slot.dataset.state = 'loaded';
            }
          }

          function renderGates(gates) {
            if (!Array.isArray(gates) || !gates.length) return;
            if (gateEmpty) gateEmpty.hidden = true;
            gates.forEach(function(g){ upsertGateChip(g.name, g.passed, g.value); });
          }

          function upsertGateChip(name, passed, value) {
            if (!name) return;
            if (gateEmpty && !gateEmpty.hidden) gateEmpty.hidden = true;
            var chip = gateChips.querySelector('[data-gate="' + name + '"]');
            if (!chip) {
              chip = document.createElement('span');
              chip.className = 'gate-chip';
              chip.dataset.gate = name;
              var nm = document.createElement('span');
              nm.className = 'gate-name';
              nm.textContent = name.replace(/_/g, ' ');
              chip.appendChild(nm);
              var val = document.createElement('span');
              val.className = 'gate-val';
              chip.appendChild(val);
              gateChips.appendChild(chip);
            }
            chip.dataset.state = passed === true ? 'pass' : passed === false ? 'fail' : 'pending';
            var v = chip.querySelector('.gate-val');
            if (v && value !== undefined && value !== null) v.textContent = String(value);
          }

          function setLane(key, state, mean) {
            var chip = document.querySelector('.lane-chip[data-lane="' + key + '"]');
            if (!chip) return;
            chip.dataset.state = state;
            if (mean !== undefined && mean !== null) {
              var v = chip.querySelector('[data-val]');
              if (v) v.textContent = (typeof mean === 'number' ? mean.toFixed(key === 'clipscore' || key === 'dino_drift' ? 3 : 2) : String(mean));
            }
          }

          function applySnapshot(s) {
            if (!s || !s.ok) return;
            if (s.status !== lastStatus) {
              logLine('status: ' + lastStatus + ' -> ' + s.status);
              lastStatus = s.status;
              statusLabel.textContent = humanStatus(s.status);
              var n = narrationFor(s.status);
              narrate(n[0], n[1]);
            }
            if (s.current_attempt !== lastAttempt) {
              lastAttempt = s.current_attempt;
              attemptCounter.textContent = 'attempt ' + s.current_attempt + ' of ' + s.max_attempts;
              resetForNewAttempt(s.current_attempt);
            }
            paintDag(s.status);

            var cur = null;
            if (Array.isArray(s.attempts)) {
              for (var i = 0; i < s.attempts.length; i++) {
                if (s.attempts[i] && s.attempts[i].attempt_index === s.current_attempt) cur = s.attempts[i];
              }
              renderAttempts(s.attempts);
            }
            if (cur) {
              if (cur.composed && cur.composed.prompt) {
                var eb = $('enhanced-block');
                if (eb && eb.hidden) {
                  eb.hidden = false;
                  $('enhanced-body').textContent = cur.composed.prompt;
                  if (cur.composed.reasoning) $('compose-reasoning').textContent = 'Why this framing: ' + cur.composed.reasoning;
                }
              }
              if (cur.eval) {
                if (cur.eval.gates) renderGates(cur.eval.gates);
                if (cur.eval.metrics) {
                  Object.keys(cur.eval.metrics).forEach(function(k){
                    var m = cur.eval.metrics[k];
                    if (m && m.summary) setLane(k, 'done', m.summary.mean);
                  });
                }
              }
              if (cur.frame_urls) renderFrameUrls(cur.frame_urls);
              if (cur.judge) renderVerdict(cur.judge);
            }

            if (errorsWrap && errorsPre) {
              var curLog = '';
              // error_log surfaces via the snapshot only on failure paths;
              // keep whatever the SSR shell had otherwise.
              if (s.status === 'failed' && s.note) curLog = s.note;
              if (curLog && curLog !== lastErrorLog) {
                errorsPre.textContent = curLog;
                errorsWrap.hidden = false;
                lastErrorLog = curLog;
              }
            }

            if (s.status === 'completed' && s.slug) {
              done = true;
              logLine('accepted — redirecting to the finished piece');
              setTimeout(function(){ location.href = '/take/' + s.slug + '/'; }, 1400);
            }
            if (s.status === 'failed') {
              done = true;
              narrate('The pipeline hit a wall', 'All attempts exhausted. The log above has the trail.');
              logLine('piece failed');
            }
          }

          async function poll() {
            if (done) return;
            try {
              var r = await fetch('/api/take/status/' + encodeURIComponent(id), { headers: { Accept: 'application/json' } });
              if (!r.ok) {
                consecutiveErrors++;
                if (consecutiveErrors < 3) logLine('status fetch returned ' + r.status);
                pollInterval = Math.min(20000, pollInterval * 1.4);
              } else {
                consecutiveErrors = 0;
                pollInterval = 4000;
                var json = await r.json();
                applySnapshot(json);
              }
            } catch (e) {
              consecutiveErrors++;
              if (consecutiveErrors < 3) logLine('network error, retrying');
            }
            if (!done) setTimeout(poll, pollInterval);
          }

          // ---- SSE: the live cascade feed ----
          var es = null;
          function setDot(state) { if (agentDot) agentDot.setAttribute('data-state', state); }
          function parseData(e) { try { return JSON.parse(e.data); } catch (err) { return {}; } }

          function handleEvalRecord(rec) {
            var ev = rec.event, stage = rec.stage, d = rec.data || {};
            if (ev === 'stage_start') {
              if (stage === 'gates') { setNode('gates', 'active'); logLine('L0 gates running'); }
              else if (stage === 'sample') { logLine('sampling 10 frames for the judge'); }
              else if (stage === 'flicker' || stage === 'flow' || stage === 'clipscore' || stage === 'dino_drift') {
                setNode('gates', 'done'); setNode('lanes', 'active'); setLane(stage, 'active');
                if (!seenStages[stage]) { seenStages[stage] = 1; logLine('L1 lane: ' + stage + ' measuring'); }
              }
              else if (stage === 'contact_sheet') { logLine('building the timestamped contact sheet'); }
            } else if (ev === 'stage_done') {
              if (stage === 'flicker' || stage === 'flow' || stage === 'clipscore' || stage === 'dino_drift') {
                setLane(stage, 'done', typeof d.mean === 'number' ? d.mean : undefined);
                logLine(stage + ' done: mean ' + (typeof d.mean === 'number' ? d.mean.toFixed(3) : '?'));
              } else if (stage === 'contact_sheet') {
                setNode('lanes', 'done');
              } else if (stage === 'gates') {
                setNode('gates', 'done');
              } else if (stage === 'ingest') {
                setNode('ingest', 'done');
              }
            } else if (ev === 'gate') {
              upsertGateChip(d.name, d.passed, d.value);
              if (d.passed === false) { setNode('gates', 'fail'); logLine('GATE FAILED: ' + d.name + ' (' + (d.value || '') + ') — retake without judging'); }
            } else if (ev === 'frame') {
              var i = typeof d.index === 'number' ? Object.keys(renderedFrames).length : 0;
              // frame events arrive in order; mark slots as sampled with timestamps
              var slotIdx = 0;
              while (renderedFrames['s' + slotIdx]) slotIdx++;
              renderedFrames['s' + slotIdx] = 1;
              var slot = framesRoot.querySelector('.take-frame-slot[data-i="' + slotIdx + '"]');
              if (slot && slot.dataset.state === 'empty') {
                slot.dataset.state = 'sampled';
                var t = slot.querySelector('[data-time]');
                if (t && typeof d.time_s === 'number') t.textContent = 't=' + d.time_s.toFixed(2) + 's';
              }
            } else if (ev === 'results') {
              logLine('eval complete in ' + (typeof d.elapsed_s === 'number' ? d.elapsed_s.toFixed(1) : '?') + 's');
            } else if (ev === 'stage_fail') {
              logLine('eval stage failed: ' + stage + (d.reason ? ' — ' + d.reason : ''));
            }
          }

          function startStream() {
            if (done || typeof EventSource === 'undefined') return;
            es = new EventSource('/api/take/stream/' + encodeURIComponent(id));
            es.addEventListener('hello', function(){
              setDot('live');
              logLine('connected to the live agent stream');
            });
            es.addEventListener('compose_start', function(e){
              var d = parseData(e);
              setNode('compose', 'active');
              logLine('agent composing the shot (attempt ' + (d.attempt || '?') + ')');
            });
            es.addEventListener('compose_done', function(e){
              var d = parseData(e);
              setNode('compose', 'done');
              var eb = $('enhanced-block');
              if (eb && d.prompt) {
                eb.hidden = false;
                $('enhanced-body').textContent = d.prompt;
                if (d.reasoning) $('compose-reasoning').textContent = 'Why this framing: ' + d.reasoning;
              }
              logLine('shot composed — submitting to ray-3.2');
            });
            es.addEventListener('compose_error', function(e){
              logLine('compose error: ' + (parseData(e).message || 'unknown'));
            });
            es.addEventListener('eval', function(e){
              handleEvalRecord(parseData(e));
            });
            es.addEventListener('judge_start', function(){
              setNode('judge', 'active');
              judgeStream.hidden = false;
              logLine('judge reading the contact sheet');
            });
            es.addEventListener('judge_token', function(e){
              var d = parseData(e);
              if (typeof d.text !== 'string') return;
              if (judgeStream.hidden) judgeStream.hidden = false;
              judgeStreamText += d.text;
              if (judgeStreamText.length > 12000) judgeStreamText = judgeStreamText.slice(-12000);
              judgeStream.textContent = judgeStreamText;
              judgeStream.scrollTop = judgeStream.scrollHeight;
            });
            es.addEventListener('judge_done', function(e){
              var d = parseData(e);
              setNode('judge', 'done');
              setNode('decision', 'active');
              renderVerdict(d);
              logLine('verdict in — applying the L3 decision rule');
            });
            es.addEventListener('judge_error', function(e){
              logLine('judge error: ' + (parseData(e).message || 'unknown'));
            });
            es.onerror = function(){ setDot('reconnecting'); };
          }

          paintDag(lastStatus);
          var n0 = narrationFor(lastStatus);
          narrate(n0[0], n0[1]);
          startStream();
          window.addEventListener('beforeunload', function(){ if (es) es.close(); });
          poll();

          function humanStatus(s) { return humanStatusMap[s] || s || 'Working'; }
          var humanStatusMap = {
            queued: 'Queued', composing: 'Composing', generating: 'Rendering on ray-3.2',
            ingesting: 'Ingesting', evaluating: 'Measuring', judging: 'Judging',
            retaking: 'Retaking', completed: 'Complete', failed: 'Failed'
          };
        })();
      </script>
    `,
  });
}

function humanStatusSSR(s: string): string {
  const map: Record<string, string> = {
    queued: "Queued",
    composing: "Composing",
    generating: "Rendering on ray-3.2",
    ingesting: "Ingesting",
    evaluating: "Measuring",
    judging: "Judging",
    retaking: "Retaking",
    completed: "Complete",
    failed: "Failed",
  };
  return map[s] ?? s;
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

type ShellOpts = { title: string; canonical: string; description: string; bodyHtml: string };

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
  <meta name="robots" content="noindex,nofollow" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;1,9..144,400;1,9..144,500&family=JetBrains+Mono:wght@400;500&display=swap"
    rel="stylesheet"
  />
  <style>${DRAFT_CSS}</style>
</head>
<body class="take-draft">
  <nav class="reader-bar" aria-label="Site">
    <a class="reader-bar-brand" href="/">Truffle</a>
    <a class="reader-bar-link" href="/take/">Take</a>
    <a class="reader-bar-link" href="/take/learn/">How the eval works</a>
  </nav>
  ${opts.bodyHtml}
</body>
</html>`;
}

const DRAFT_CSS = `
  :root {
    --paper: #fbfaf5; --paper-2: #f4f1e8; --paper-3: #e9e4d4;
    --ink: #1a1612; --ink-2: #3a342b; --ink-3: #736a52;
    --line: #d8d1bd;
    --accent: #2d5fb8; --accent-2: #234c96;
    --ok: #2e7d4f; --warn: #c19018; --bad: #b94c4c;
    --font-serif: "Fraunces", Georgia, serif;
    --font-sans: "Inter", system-ui, sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, monospace;
    --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
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
  .mono { font-family: var(--font-mono); font-size: 0.92em; }
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
  .reader-page { max-width: 1100px; margin: 0 auto; padding: 48px 24px 96px; }
  .reader-eyebrow {
    margin: 0 0 12px; font-family: var(--font-mono); font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.14em;
  }
  .reader-eyebrow a { color: var(--ink-3); text-decoration: none; }
  .reader-eyebrow a:hover { color: var(--accent); }
  .reader-title {
    font-family: var(--font-serif); font-weight: 400;
    font-size: clamp(26px, 4vw, 40px); line-height: 1.12; letter-spacing: -0.01em; margin: 0 0 14px;
  }
  .reader-meta {
    font-family: var(--font-mono); font-size: 12px; color: var(--ink-3);
    margin: 0 0 32px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px;
  }
  .reader-dot { margin: 0 4px; }
  .reader-lead { color: var(--ink-2); max-width: 60ch; }
  .draft-status { color: var(--accent); font-weight: 500; position: relative; padding-left: 16px; }
  .draft-status::before {
    content: ''; position: absolute; left: 0; top: 50%; width: 8px; height: 8px;
    background: var(--accent); border-radius: 999px; transform: translateY(-50%);
    animation: pulse 1.2s ease-in-out infinite alternate;
  }
  @keyframes pulse {
    from { opacity: 0.35; transform: translateY(-50%) scale(0.85); }
    to   { opacity: 1; transform: translateY(-50%) scale(1.1); }
  }
  .reader-h2 { font-family: var(--font-serif); font-weight: 400; font-size: 22px; margin: 40px 0 12px; }
  .reader-h2-aside { font-family: var(--font-mono); font-size: 11px; color: var(--ink-3); letter-spacing: 0.06em; margin-left: 10px; text-transform: uppercase; }
  .take-hint { color: var(--ink-3); font-size: 13.5px; max-width: 64ch; margin: 0 0 14px; }

  .draft-narration {
    margin: 0 0 36px; padding: 22px 24px 18px;
    border: 1px solid var(--line); border-radius: 14px;
    background: linear-gradient(180deg, color-mix(in oklab, var(--accent) 6%, var(--paper-2)) 0%, var(--paper-2) 65%);
    position: relative;
  }
  .draft-narration::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
    background: var(--accent); border-top-left-radius: 14px; border-bottom-left-radius: 14px;
  }
  .draft-narration-eyebrow {
    margin: 0 0 6px; font-family: var(--font-mono); font-size: 10.5px;
    text-transform: uppercase; letter-spacing: 0.18em; color: var(--accent);
  }
  .draft-narration-title {
    margin: 0 0 8px; font-family: var(--font-serif); font-weight: 400; font-style: italic;
    font-size: clamp(20px, 2.6vw, 26px); line-height: 1.25;
    display: flex; align-items: baseline; gap: 4px; flex-wrap: wrap;
  }
  .draft-narration-cursor {
    display: inline-block; width: 2px; height: 1em; background: var(--accent);
    transform: translateY(2px); animation: blink 1.05s steps(2, end) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  .draft-narration-body { margin: 0; color: var(--ink-2); font-size: 14.5px; line-height: 1.55; max-width: 66ch; }

  /* ---- DAG rail ---- */
  .dag-rail {
    list-style: none; margin: 0 0 20px; padding: 0;
    display: flex; flex-wrap: wrap; gap: 14px 0; align-items: stretch;
  }
  .dag-node {
    position: relative; display: flex; flex-direction: column; gap: 2px;
    padding: 12px 32px 12px 14px; min-width: 128px;
  }
  .dag-dot {
    width: 12px; height: 12px; border-radius: 999px;
    border: 2px solid var(--ink-3); background: transparent; margin-bottom: 6px;
    transition: background 0.3s var(--ease-out), border-color 0.3s var(--ease-out);
  }
  .dag-node[data-state="active"] .dag-dot {
    border-color: var(--accent); background: var(--accent);
    animation: pulse2 1.1s ease-in-out infinite alternate;
  }
  @keyframes pulse2 { from { opacity: 0.45; } to { opacity: 1; } }
  .dag-node[data-state="done"] .dag-dot { border-color: var(--ok); background: var(--ok); animation: none; }
  .dag-node[data-state="fail"] .dag-dot { border-color: var(--bad); background: var(--bad); animation: none; }
  .dag-label { font-family: var(--font-mono); font-size: 12.5px; font-weight: 500; letter-spacing: 0.02em; }
  .dag-node[data-state="pending"] .dag-label { color: var(--ink-3); }
  .dag-node[data-state="active"] .dag-label { color: var(--accent); }
  .dag-node[data-state="done"] .dag-label { color: var(--ink); }
  .dag-node[data-state="fail"] .dag-label { color: var(--bad); }
  .dag-sub { font-size: 11px; color: var(--ink-3); }
  .dag-link {
    position: absolute; right: 6px; top: 17px; width: 20px; height: 2px;
    background: var(--line);
  }
  .dag-node[data-state="done"] .dag-link { background: color-mix(in oklab, var(--ok) 55%, var(--line)); }

  .dag-detail { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  @media (max-width: 760px) { .dag-detail { grid-template-columns: 1fr; } }
  .dag-detail-block {
    border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; background: var(--paper-2);
  }
  .dag-detail-h {
    margin: 0 0 10px; font-family: var(--font-mono); font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink-3); font-weight: 500;
  }
  .gate-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .gate-empty { font-size: 12.5px; color: var(--ink-3); }
  .gate-chip {
    display: inline-flex; align-items: baseline; gap: 7px;
    border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px;
    font-family: var(--font-mono); font-size: 11.5px; background: var(--paper);
  }
  .gate-chip[data-state="pass"] { border-color: color-mix(in oklab, var(--ok) 50%, var(--line)); }
  .gate-chip[data-state="pass"] .gate-name::before { content: '✓ '; color: var(--ok); }
  .gate-chip[data-state="fail"] { border-color: var(--bad); background: color-mix(in oklab, var(--bad) 8%, var(--paper)); }
  .gate-chip[data-state="fail"] .gate-name::before { content: '✗ '; color: var(--bad); }
  .gate-val { color: var(--ink-3); }
  .lane-chips { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .lane-chip {
    display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
    border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px;
    font-family: var(--font-mono); font-size: 12px; background: var(--paper);
  }
  .lane-chip[data-state="active"] { border-color: var(--accent); }
  .lane-chip[data-state="active"] .lane-name { color: var(--accent); }
  .lane-chip[data-state="done"] { border-color: color-mix(in oklab, var(--ok) 45%, var(--line)); }
  .lane-name { color: var(--ink-2); }
  .lane-val { font-variant-numeric: tabular-nums; color: var(--ink); font-weight: 500; }

  /* ---- frames ---- */
  .take-frames {
    display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px;
  }
  @media (max-width: 640px) { .take-frames { grid-template-columns: repeat(3, 1fr); } }
  .take-frame-slot {
    position: relative; aspect-ratio: 16 / 9; border: 1px solid var(--line);
    border-radius: 8px; background: var(--paper-2); overflow: hidden;
  }
  .take-frame-slot[data-state="sampled"] {
    background: linear-gradient(110deg, var(--paper-2) 8%, var(--paper-3) 18%, var(--paper-2) 33%);
    background-size: 200% 100%;
    animation: shimmer 1.4s linear infinite;
  }
  @keyframes shimmer { to { background-position-x: -200%; } }
  .take-frame-slot img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .take-frame-time {
    position: absolute; bottom: 5px; left: 6px; z-index: 1;
    font-family: var(--font-mono); font-size: 9.5px; color: var(--ink-3);
    background: color-mix(in oklab, var(--paper) 80%, transparent);
    padding: 1px 5px; border-radius: 4px;
  }
  .take-frame-slot[data-state="loaded"] .take-frame-time { color: #fff; background: rgba(0,0,0,0.55); }

  /* ---- judge ---- */
  .draft-agent-dot {
    display: inline-block; width: 9px; height: 9px; border-radius: 999px;
    background: var(--ink-3); vertical-align: middle; margin-left: 4px;
  }
  .draft-agent-dot[data-state="live"] { background: var(--ok); animation: pulse2 1.2s ease-in-out infinite alternate; }
  .draft-agent-dot[data-state="reconnecting"] { background: var(--warn); }
  .judge-stream {
    max-height: 260px; overflow-y: auto; margin: 0 0 16px;
    border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px;
    background: var(--paper-2); font-family: var(--font-mono); font-size: 12px;
    line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: var(--ink-2);
  }
  .axis-grid { display: flex; flex-direction: column; gap: 0; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .axis-row {
    display: grid; grid-template-columns: 120px 90px 1fr; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--paper-2);
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
    .axis-row { grid-template-columns: 90px 70px; }
    .axis-rationale { grid-column: 1 / -1; }
  }
  .judge-summary { margin: 14px 0 0; color: var(--ink-2); font-size: 14px; max-width: 68ch; font-style: italic; }

  /* ---- attempts / log / errors ---- */
  .attempt-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .attempt-item {
    border: 1px solid var(--line); border-left-width: 3px; border-radius: 8px;
    padding: 10px 14px; background: var(--paper-2); font-size: 13px;
    display: flex; flex-direction: column; gap: 3px;
  }
  .attempt-item[data-decision="accept"] { border-left-color: var(--ok); }
  .attempt-item[data-decision="retake"] { border-left-color: var(--warn); }
  .attempt-item[data-decision="abort"] { border-left-color: var(--bad); }
  .attempt-head { font-family: var(--font-mono); font-size: 12px; color: var(--ink); }
  .attempt-why { color: var(--ink-3); font-size: 12.5px; }
  .draft-log {
    list-style: none; margin: 0; padding: 14px 16px;
    border: 1px solid var(--line); border-radius: 10px; background: var(--paper-2);
    font-family: var(--font-mono); font-size: 12px; line-height: 1.7;
    max-height: 280px; overflow-y: auto; color: var(--ink-2);
  }
  .draft-log-when { color: var(--ink-3); margin-right: 6px; font-size: 11px; }
  .draft-errors-pre {
    border: 1px solid color-mix(in oklab, var(--bad) 35%, var(--line));
    border-radius: 10px; background: color-mix(in oklab, var(--bad) 4%, var(--paper-2));
    padding: 14px 16px; font-family: var(--font-mono); font-size: 11.5px;
    white-space: pre-wrap; word-break: break-word; color: var(--ink-2);
    max-height: 220px; overflow-y: auto;
  }
  .reader-detail { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 8px; }
  @media (max-width: 760px) { .reader-detail { grid-template-columns: 1fr; } }
  .reader-body { color: var(--ink-2); font-size: 14.5px; }
  .take-btn {
    display: inline-block; padding: 10px 22px; border-radius: 999px;
    font-size: 14px; text-decoration: none; border: 1px solid var(--line); color: var(--ink);
  }
  .take-btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
`;
