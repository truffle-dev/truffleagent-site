// GET /reel/draft/<id>/
// In-progress view for a Reel piece currently being generated.
// Renders a streaming grid of N frame slots that fill as the agent
// finishes each panel. SSR shell + client poll loop.
//
// Two routes feed this view:
//   - Direct: user clicks Generate, lands here while the pipeline runs
//   - Redirect: reader view (/reel/<slug>/) 302s here if status != completed
//
// This is the skeleton for roadmap item 1.4.2. It renders correctly even
// before /api/reel/status/:id exists (the poll handles 404 gracefully).
// As soon as the status endpoint lands and starts returning per-frame
// updates, the grid below populates without a code change.

import { type ReelEnv } from "../../_reel-shared.ts";

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
  error_log: string | null;
  completed_at: string | null;
};

export const onRequestGet: PagesFunction<ReelEnv, "id"> = async (ctx) => {
  const id = String(ctx.params.id ?? "").trim();
  if (!id || id.length > 32 || !/^[a-z0-9_]+$/i.test(id)) {
    return notFound("That draft id doesn't look right.");
  }

  let piece: PieceRow | null = null;
  try {
    piece = await ctx.env.DB
      .prepare(
        `SELECT id, slug, character_raw, character_enhanced, story_raw,
                story_enhanced, mode, frame_count, master_ref_url, status,
                visible, error_log, completed_at
         FROM reel_pieces
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(id)
      .first<PieceRow>();
  } catch {
    piece = null;
  }

  if (!piece) {
    return notFound("No draft by that id. It may have been cleaned up.");
  }

  // If the piece is already completed, send the reader to the published view.
  if (piece.status === "completed" && piece.visible) {
    return Response.redirect(
      new URL(`/reel/${encodeURIComponent(piece.slug)}/`, ctx.request.url).toString(),
      302,
    );
  }

  const html = renderDraft(piece);
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Drafts are live — keep edge cache short so the SSR shell reflects
      // status transitions quickly. The poll loop drives the live updates.
      "Cache-Control": "private, max-age=5",
    },
  });
};

function notFound(detail: string): Response {
  const html = renderShell({
    title: "Reel · draft not found",
    canonical: "https://truffleagent.com/reel/",
    description: "This Reel draft is not available.",
    bodyHtml: `
      <main class="reader-page">
        <p class="reader-eyebrow"><a href="/reel/">Back to Reel</a></p>
        <h1 class="reader-title">Nothing in flight here.</h1>
        <p class="reader-lead">${escapeHtml(detail)}</p>
        <p class="reader-cta">
          <a class="reader-btn reader-btn-primary" href="/reel/">Open the studio</a>
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

function renderDraft(piece: PieceRow): string {
  const title = derivedTitle(piece.story_enhanced ?? piece.story_raw);
  const characterDesc = piece.character_enhanced ?? piece.character_raw;
  const storyDesc = piece.story_enhanced ?? piece.story_raw;
  const slots = Array.from({ length: piece.frame_count }, (_, i) => i);

  const statusLabel = humanStatus(piece.status);

  return renderShell({
    title: `Drafting · ${title} · Reel`,
    canonical: `https://truffleagent.com/reel/draft/${piece.id}/`,
    description: `A Reel piece is being generated. ${piece.frame_count} frames, ${piece.mode} mode.`,
    bodyHtml: `
      <main class="reader-page">
        <header class="reader-head">
          <p class="reader-eyebrow"><a href="/reel/">Reel</a></p>
          <h1 class="reader-title">${escapeHtml(title)}</h1>
          <p class="reader-meta">
            <span class="draft-status" id="draft-status-label">${escapeHtml(statusLabel)}</span>
            <span class="reader-dot">·</span>
            <span id="draft-progress-counter">0 / ${piece.frame_count}</span>
          </p>
        </header>

        <section class="draft-narration" aria-live="polite" aria-label="Agent narration">
          <p class="draft-narration-eyebrow">The agent · live</p>
          <h2 class="draft-narration-title" id="draft-narration-title">
            <span id="draft-narration-headline">Spinning up the pipeline</span><span class="draft-narration-cursor" aria-hidden="true"></span>
          </h2>
          <p class="draft-narration-body" id="draft-narration-body">
            Reading your character and story. The director is queuing the first move.
          </p>
          <ul class="draft-narration-stats" id="draft-narration-stats">
            <li><span class="draft-narration-stat-num" data-stat="in_flight">0</span><span class="draft-narration-stat-lbl">drawing</span></li>
            <li><span class="draft-narration-stat-num" data-stat="inspecting">0</span><span class="draft-narration-stat-lbl">inspecting</span></li>
            <li><span class="draft-narration-stat-num" data-stat="retrying">0</span><span class="draft-narration-stat-lbl">retrying</span></li>
            <li><span class="draft-narration-stat-num" data-stat="accepted">0</span><span class="draft-narration-stat-lbl">accepted</span></li>
            <li><span class="draft-narration-stat-num" data-stat="failed">0</span><span class="draft-narration-stat-lbl">failed</span></li>
          </ul>
        </section>

        <section class="draft-master" aria-label="Character reference">
          <h2 class="reader-h2">Character reference</h2>
          <div class="draft-master-wrap" id="draft-master-wrap">
            ${
              piece.master_ref_url
                ? `<img src="${escapeHtml(piece.master_ref_url)}" alt="Character reference" />`
                : `<div class="draft-master-skel">Drawing the character sheet…</div>`
            }
          </div>
        </section>

        <section class="draft-grid-wrap" aria-label="Frame grid">
          <h2 class="reader-h2">Frames</h2>
          <div class="draft-grid" id="draft-grid">
            ${
              slots
                .map(
                  (i) => `
              <div class="draft-slot" data-i="${i}" data-status="queued">
                <div class="draft-slot-fill"></div>
                <span class="draft-slot-num">${i + 1}</span>
                <span class="draft-slot-verb" data-verb="queued">queued</span>
              </div>`,
                )
                .join("")
            }
          </div>
        </section>

        <section class="draft-log-wrap" aria-label="Agent log">
          <h2 class="reader-h2">Agent log</h2>
          <ol class="draft-log" id="draft-log">
            <li><span class="draft-log-when">just now</span> draft opened, polling status</li>
          </ol>
        </section>

        <section class="draft-agent-wrap" aria-label="Live agent feed">
          <h2 class="reader-h2">Watch the agent <span class="draft-agent-dot" id="draft-agent-dot" title="stream status" aria-hidden="true"></span></h2>
          <p class="draft-errors-hint">Live feed from the inspection agent. When a frame comes back from Luma, Claude Opus reads the character sheet and the candidate side by side and rules on identity drift, in real time.</p>
          <ol class="draft-log" id="draft-agent-log">
            <li id="draft-agent-placeholder"><span class="draft-log-when">waiting</span> connecting to the agent stream</li>
          </ol>
        </section>

        <section class="draft-errors-wrap" id="draft-errors-wrap" aria-label="Pipeline issues"${piece.error_log ? "" : " hidden"}>
          <h2 class="reader-h2">Pipeline issues</h2>
          <p class="draft-errors-hint">Non-fatal failures the pipeline retried or skipped. Frames usually still recover on the next pass.</p>
          <pre class="draft-errors-pre" id="draft-errors-pre">${piece.error_log ? escapeHtml(piece.error_log) : ""}</pre>
        </section>

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
      </main>

      <script>
        (function(){
          var id = ${JSON.stringify(piece.id)};
          var total = ${piece.frame_count};
          var statusLabel = document.getElementById('draft-status-label');
          var counter = document.getElementById('draft-progress-counter');
          var grid = document.getElementById('draft-grid');
          var log = document.getElementById('draft-log');
          var masterWrap = document.getElementById('draft-master-wrap');
          var errorsWrap = document.getElementById('draft-errors-wrap');
          var errorsPre = document.getElementById('draft-errors-pre');
          var lastErrorLog = errorsPre ? errorsPre.textContent : '';
          var narrationHeadline = document.getElementById('draft-narration-headline');
          var narrationBody = document.getElementById('draft-narration-body');
          var statsRoot = document.getElementById('draft-narration-stats');
          var pollInterval = 3000;
          var consecutiveErrors = 0;
          var done = false;
          var lastNarrationKey = '';

          // Stable, prose-style narration for each top-level status. Updates
          // when the *combination* of status + frame-counts changes, not on
          // every poll, so the panel doesn't flicker.
          function narrationFor(status, counts) {
            var ip = counts.in_flight || 0;
            var insp = counts.inspecting || 0;
            var retry = counts.retrying || 0;
            var ok = counts.accepted || 0;
            var fail = counts.failed || 0;
            switch (status) {
              case 'queued':
                return {
                  title: 'Queueing the work',
                  body: 'Reading your character and story. The pipeline is about to dispatch the first move to Luma.',
                };
              case 'master_in_flight':
                return {
                  title: 'Drawing the character sheet',
                  body: 'Every frame will anchor to this one image. That is why frame 12 looks like frame 1 — instead of chaining frames off each other, the agent re-anchors each render against the same reference. About 30 seconds.',
                };
              case 'frames_in_flight':
                if (ip + insp + retry === 0 && ok === 0) {
                  return {
                    title: 'Dispatching frames in parallel',
                    body: 'The director is sending frames to Luma four at a time. Each one carries the same character anchor, so identity holds across the strip.',
                  };
                }
                if (insp > 0) {
                  return {
                    title: 'Opus is inspecting for drift',
                    body: 'A frame came back. Claude Opus 4.7 is comparing it to the character sheet — if it drifts, the agent rejects it and queues a retry. ' + ok + ' accepted, ' + insp + ' under review.',
                  };
                }
                if (retry > 0) {
                  return {
                    title: 'Retrying a frame the agent rejected',
                    body: 'One of the returns drifted from the character sheet. The director is re-issuing it with the same anchor. ' + retry + ' frame' + (retry === 1 ? '' : 's') + ' in retry.',
                  };
                }
                if (ip > 0) {
                  return {
                    title: 'Rendering ' + ip + ' frame' + (ip === 1 ? '' : 's') + ' on Luma',
                    body: 'Frames are out the door. Each typical render runs ~30s. ' + ok + ' of ' + total + ' accepted so far.',
                  };
                }
                return {
                  title: 'Waiting for the next batch',
                  body: 'Between dispatches. The agent rate-limits itself to keep Luma happy. ' + ok + ' of ' + total + ' accepted.',
                };
              case 'completed':
                return {
                  title: 'Done. Routing you to the reader view.',
                  body: ok + ' of ' + total + ' frames landed. ' + (fail ? fail + ' did not — the comic ships with what came back.' : 'Clean run.'),
                };
              case 'failed':
                return {
                  title: 'The pipeline hit a wall',
                  body: 'Something stopped the run. The Pipeline issues section below has the tail of the error log.',
                };
              default:
                return { title: 'Working', body: 'Status: ' + status };
            }
          }

          function updateNarration(status, counts) {
            if (!narrationHeadline || !narrationBody) return;
            var n = narrationFor(status, counts);
            var key = status + '|' + (counts.in_flight||0) + '|' + (counts.inspecting||0) + '|' + (counts.retrying||0) + '|' + (counts.accepted||0) + '|' + (counts.failed||0);
            if (key === lastNarrationKey) return;
            lastNarrationKey = key;
            narrationHeadline.textContent = n.title;
            narrationBody.textContent = n.body;
            if (statsRoot) {
              var nodes = statsRoot.querySelectorAll('[data-stat]');
              for (var i = 0; i < nodes.length; i++) {
                var k = nodes[i].getAttribute('data-stat');
                nodes[i].textContent = String(counts[k] || 0);
              }
            }
          }

          function verbFor(status) {
            switch (status) {
              case 'queued': return 'queued';
              case 'in_flight': return 'drawing';
              case 'inspecting': return 'inspecting';
              case 'rejected_retrying': return 'retrying';
              case 'accepted': return '';
              case 'failed': return 'failed';
              default: return status || '';
            }
          }

          function logLine(text) {
            var li = document.createElement('li');
            var when = document.createElement('span');
            when.className = 'draft-log-when';
            when.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            li.appendChild(when);
            li.appendChild(document.createTextNode(' ' + text));
            log.insertBefore(li, log.firstChild);
            while (log.children.length > 60) log.removeChild(log.lastChild);
          }

          function resetSlotSkeleton(slot, i) {
            slot.innerHTML = '';
            var fill = document.createElement('div');
            fill.className = 'draft-slot-fill';
            slot.appendChild(fill);
            var num = document.createElement('span');
            num.className = 'draft-slot-num';
            num.textContent = String(i + 1);
            slot.appendChild(num);
            var verb = document.createElement('span');
            verb.className = 'draft-slot-verb';
            verb.setAttribute('data-verb', slot.dataset.status || 'queued');
            verb.textContent = verbFor(slot.dataset.status || 'queued');
            slot.appendChild(verb);
          }

          function paintSlotVerb(slot, status) {
            var existing = slot.querySelector('.draft-slot-verb');
            var label = verbFor(status);
            if (status === 'accepted' || !label) {
              if (existing) existing.remove();
              return;
            }
            if (existing) {
              existing.setAttribute('data-verb', status);
              existing.textContent = label;
              return;
            }
            var verb = document.createElement('span');
            verb.className = 'draft-slot-verb';
            verb.setAttribute('data-verb', status);
            verb.textContent = label;
            slot.appendChild(verb);
          }

          function mountActions(slot, i) {
            if (slot.querySelector('.draft-slot-actions')) return;
            var actions = document.createElement('div');
            actions.className = 'draft-slot-actions';
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'draft-slot-regen-btn';
            btn.textContent = 'Regenerate';
            btn.setAttribute('aria-label', 'Regenerate panel ' + (i + 1));
            btn.addEventListener('click', function(){ openRegenForm(slot, i); });
            actions.appendChild(btn);
            slot.appendChild(actions);
          }

          function openRegenForm(slot, i) {
            var existing = slot.querySelector('.draft-slot-regen-form');
            if (existing) { existing.remove(); return; }
            var form = document.createElement('form');
            form.className = 'draft-slot-regen-form';
            var textarea = document.createElement('textarea');
            textarea.placeholder = 'Optional hint, e.g. "more dramatic shadow on the left". Leave blank to just redraw.';
            textarea.maxLength = 240;
            textarea.rows = 3;
            var btnRow = document.createElement('div');
            btnRow.className = 'draft-slot-regen-buttons';
            var sendBtn = document.createElement('button');
            sendBtn.type = 'submit';
            sendBtn.className = 'draft-slot-regen-send';
            sendBtn.textContent = 'Regenerate';
            var cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'draft-slot-regen-cancel';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.addEventListener('click', function(){ form.remove(); });
            btnRow.appendChild(sendBtn);
            btnRow.appendChild(cancelBtn);
            form.appendChild(textarea);
            form.appendChild(btnRow);
            form.addEventListener('submit', function(ev){
              ev.preventDefault();
              var hint = textarea.value.trim();
              sendBtn.disabled = true;
              cancelBtn.disabled = true;
              sendBtn.textContent = 'Sending…';
              submitRegen(slot, i, hint, function(ok, msg){
                if (ok) {
                  logLine('regenerating panel ' + (i + 1) + (hint ? ' with hint' : ''));
                  form.remove();
                  // Force the slot into in_flight visuals immediately; poll will repaint.
                  slot.dataset.status = 'in_flight';
                  resetSlotSkeleton(slot, i);
                  // Speed up the next poll so the user sees motion fast.
                  pollInterval = 1500;
                } else {
                  sendBtn.disabled = false;
                  cancelBtn.disabled = false;
                  sendBtn.textContent = 'Regenerate';
                  logLine('regenerate failed: ' + (msg || 'unknown'));
                }
              });
            });
            slot.appendChild(form);
            try { textarea.focus(); } catch (_) {}
          }

          function submitRegen(slot, i, hint, cb) {
            var payload = { piece_id: id, frame_index: i };
            if (hint) payload.hint = hint;
            fetch('/api/reel/regenerate-frame', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }).then(function(r){
              return r.json().catch(function(){ return null; }).then(function(j){ return { ok: r.ok, body: j, status: r.status }; });
            }).then(function(res){
              if (res.ok && res.body && res.body.ok) {
                cb(true, null);
              } else {
                var msg = (res.body && (res.body.message || res.body.error)) || ('HTTP ' + res.status);
                cb(false, msg);
              }
            }).catch(function(e){
              cb(false, (e && e.message) || 'network error');
            });
          }

          function setSlot(i, status, url) {
            var slot = grid.querySelector('.draft-slot[data-i="' + i + '"]');
            if (!slot) return;
            var prev = slot.dataset.status;
            slot.dataset.status = status;
            // Transitioning OFF accepted (user-initiated regen): clear the old img
            // so the next accepted state can render a fresh one.
            if (prev === 'accepted' && status !== 'accepted') {
              resetSlotSkeleton(slot, i);
              return;
            }
            if (status === 'accepted' && url) {
              var existingImg = slot.querySelector('img');
              if (!existingImg) {
                slot.innerHTML = '';
                var img = new Image();
                img.src = url;
                img.alt = 'Panel ' + (i + 1);
                img.loading = 'lazy';
                img.decoding = 'async';
                slot.appendChild(img);
                var num = document.createElement('span');
                num.className = 'draft-slot-num';
                num.textContent = String(i + 1);
                slot.appendChild(num);
                mountActions(slot, i);
              } else if (existingImg.getAttribute('src') !== url) {
                // URL changed (e.g. accepted again after regen) — swap in place.
                existingImg.src = url;
                mountActions(slot, i);
              } else {
                mountActions(slot, i);
              }
            }
            paintSlotVerb(slot, status);
          }

          async function poll() {
            if (done) return;
            try {
              var r = await fetch('/api/reel/status/' + encodeURIComponent(id), { headers: { Accept: 'application/json' } });
              if (r.status === 404) {
                // Endpoint not yet deployed. Back off but keep polling.
                consecutiveErrors++;
                if (consecutiveErrors === 1) logLine('status endpoint not live yet, will retry');
                pollInterval = Math.min(20000, pollInterval * 1.4);
              } else if (!r.ok) {
                consecutiveErrors++;
                if (consecutiveErrors < 3) logLine('status fetch returned ' + r.status);
              } else {
                consecutiveErrors = 0;
                pollInterval = 3000;
                var json = await r.json();
                if (json && json.ok) handleStatus(json);
              }
            } catch (e) {
              consecutiveErrors++;
              if (consecutiveErrors < 3) logLine('network error, retrying');
            }
            if (!done) setTimeout(poll, pollInterval);
          }

          function handleStatus(s) {
            if (s.status && statusLabel.textContent !== humanStatus(s.status)) {
              statusLabel.textContent = humanStatus(s.status);
              logLine('status -> ' + s.status);
            }
            if (s.master_ref_url && !masterWrap.querySelector('img')) {
              masterWrap.innerHTML = '';
              var img = new Image();
              img.src = s.master_ref_url;
              img.alt = 'Character reference';
              masterWrap.appendChild(img);
              logLine('character sheet ready');
            }
            var done_count = 0;
            var counts = { in_flight: 0, inspecting: 0, retrying: 0, accepted: 0, failed: 0, queued: 0 };
            if (Array.isArray(s.frames)) {
              for (var i = 0; i < s.frames.length; i++) {
                var f = s.frames[i];
                if (!f) continue;
                setSlot(f.frame_index, f.status, f.image_url);
                if (f.status === 'accepted') { done_count++; counts.accepted++; }
                else if (f.status === 'in_flight') counts.in_flight++;
                else if (f.status === 'inspecting') counts.inspecting++;
                else if (f.status === 'rejected_retrying') counts.retrying++;
                else if (f.status === 'failed') counts.failed++;
                else if (f.status === 'queued') counts.queued++;
              }
            }
            updateNarration(s.status || 'queued', counts);
            if (counter) counter.textContent = done_count + ' / ' + total;
            if (errorsWrap && errorsPre) {
              var currentLog = s.error_log || '';
              if (currentLog !== lastErrorLog) {
                errorsPre.textContent = currentLog;
                if (currentLog) {
                  errorsWrap.hidden = false;
                  if (!lastErrorLog) logLine('pipeline reported a non-fatal issue, see Pipeline issues');
                } else {
                  errorsWrap.hidden = true;
                }
                lastErrorLog = currentLog;
              }
            }
            if (s.status === 'completed' && s.slug) {
              done = true;
              logLine('piece complete, redirecting to reader view');
              setTimeout(function(){ location.href = '/reel/' + s.slug + '/'; }, 1200);
            }
            if (s.status === 'failed') {
              done = true;
              var tail = (s.error_log || '').split('\\n').pop() || 'unknown';
              logLine('piece failed: ' + tail);
            }
          }

          function humanStatus(s) {
            switch (s) {
              case 'queued': return 'Queued';
              case 'master_in_flight': return 'Drawing the character';
              case 'frames_in_flight': return 'Rendering frames';
              case 'completed': return 'Complete';
              case 'failed': return 'Failed';
              default: return s || 'Working';
            }
          }

          // ---- Phase B: live agent feed over SSE ----
          // /api/reel/stream/<id> proxies the bridge's per-piece channel.
          // EventSource auto-reconnects (bridge sends retry: 3000), which
          // also covers the Pages Function isolate wall-clock cap.
          var agentLog = document.getElementById('draft-agent-log');
          var agentDot = document.getElementById('draft-agent-dot');
          var es = null;

          function agentLine(text) {
            if (!agentLog) return;
            var li = document.createElement('li');
            var when = document.createElement('span');
            when.className = 'draft-log-when';
            when.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            li.appendChild(when);
            li.appendChild(document.createTextNode(' ' + text));
            agentLog.insertBefore(li, agentLog.firstChild);
            while (agentLog.children.length > 60) agentLog.removeChild(agentLog.lastChild);
          }

          function setDot(state) {
            if (agentDot) agentDot.setAttribute('data-state', state);
          }

          function parseData(e) {
            try { return JSON.parse(e.data); } catch (err) { return {}; }
          }

          function startAgentStream() {
            if (done || typeof EventSource === 'undefined' || !agentLog) return;
            es = new EventSource('/api/reel/stream/' + encodeURIComponent(id));
            es.addEventListener('hello', function () {
              var wasLive = agentDot && agentDot.getAttribute('data-state') === 'live';
              setDot('live');
              var ph = document.getElementById('draft-agent-placeholder');
              if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
              if (!wasLive) agentLine('connected to the agent stream');
            });
            es.addEventListener('inspect_start', function (e) {
              var d = parseData(e);
              var name = '';
              if (typeof d.frame_url === 'string') {
                var parts = d.frame_url.split('/');
                name = parts[parts.length - 1] || '';
              }
              agentLine('Opus is reading the character sheet and a candidate frame' + (name ? ' (' + name + ')' : ''));
            });
            es.addEventListener('inspect_verdict', function (e) {
              var d = parseData(e);
              var v = {};
              if (typeof d.raw === 'string') {
                try { v = JSON.parse(d.raw.replace(/^[\\s\\S]*?\\{/, '{')); } catch (err) { v = {}; }
              }
              var bits = [];
              if (typeof v.drift === 'number') bits.push('drift ' + v.drift + '/5');
              if (typeof v.accept === 'boolean') bits.push(v.accept ? 'accepted' : 'rejected');
              if (typeof v.reason === 'string' && v.reason) bits.push(v.reason);
              var tailBits = [];
              if (typeof d.cost_usd === 'number') tailBits.push('$' + d.cost_usd.toFixed(3));
              if (typeof d.duration_ms === 'number') tailBits.push(Math.round(d.duration_ms / 1000) + 's');
              agentLine('verdict: ' + (bits.length ? bits.join(', ') : 'returned') + (tailBits.length ? ' [' + tailBits.join(', ') + ']' : ''));
            });
            es.addEventListener('inspect_error', function (e) {
              var d = parseData(e);
              agentLine('inspection error: ' + (typeof d.message === 'string' ? d.message : 'unknown'));
            });
            es.onerror = function () {
              setDot('reconnecting');
            };
          }

          startAgentStream();
          window.addEventListener('beforeunload', function () { if (es) es.close(); });

          poll();
        })();
      </script>
    `,
  });
}

type ShellOpts = {
  title: string;
  canonical: string;
  description: string;
  bodyHtml: string;
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
<body class="reel-draft">
  <nav class="reader-bar" aria-label="Site">
    <a class="reader-bar-brand" href="/">Truffle</a>
    <a class="reader-bar-link" href="/reel/">Reel</a>
  </nav>
  ${opts.bodyHtml}
</body>
</html>`;
}

const DRAFT_CSS = `
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
  .reader-bar a { color: var(--ink); text-decoration: none; font-size: 14px; }
  .reader-bar-brand { font-family: var(--font-serif); font-size: 18px; font-weight: 500; }
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
  .reader-eyebrow a { color: var(--ink-3); text-decoration: none; }
  .reader-eyebrow a:hover { color: var(--accent); }
  .reader-title {
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: clamp(28px, 4.5vw, 44px);
    line-height: 1.1;
    letter-spacing: -0.01em;
    margin: 0 0 16px;
  }
  .reader-meta {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ink-3);
    margin: 0 0 36px;
  }
  .reader-dot { margin: 0 6px; color: var(--ink-3); }
  .draft-status {
    color: var(--accent);
    font-weight: 500;
    position: relative;
    padding-left: 16px;
  }
  .draft-status::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    width: 8px;
    height: 8px;
    background: var(--accent);
    border-radius: 999px;
    transform: translateY(-50%);
    animation: draft-pulse 1.2s ease-in-out infinite alternate;
  }
  @keyframes draft-pulse {
    from { opacity: 0.35; transform: translateY(-50%) scale(0.85); }
    to   { opacity: 1;    transform: translateY(-50%) scale(1.1); }
  }
  .reader-h2 {
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 22px;
    margin: 0 0 12px;
  }

  /* Agent narration — live "what's the agent doing" panel */
  .draft-narration {
    margin: 0 0 40px;
    padding: 22px 24px 18px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background:
      linear-gradient(180deg,
        color-mix(in oklab, var(--accent) 6%, var(--paper-2)) 0%,
        var(--paper-2) 65%);
    position: relative;
  }
  .draft-narration::before {
    content: '';
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 3px;
    background: var(--accent);
    border-top-left-radius: 14px;
    border-bottom-left-radius: 14px;
  }
  .draft-narration-eyebrow {
    margin: 0 0 6px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--accent);
  }
  .draft-narration-title {
    margin: 0 0 8px;
    font-family: var(--font-serif);
    font-weight: 400;
    font-style: italic;
    font-size: clamp(20px, 2.6vw, 26px);
    line-height: 1.25;
    color: var(--ink);
    letter-spacing: -0.005em;
    display: flex;
    align-items: baseline;
    gap: 4px;
    flex-wrap: wrap;
  }
  .draft-narration-cursor {
    display: inline-block;
    width: 2px;
    height: 1em;
    background: var(--accent);
    transform: translateY(2px);
    animation: draft-blink 1.05s steps(2, end) infinite;
  }
  @keyframes draft-blink {
    50% { opacity: 0; }
  }
  .draft-narration-body {
    margin: 0 0 14px;
    color: var(--ink-2);
    font-size: 14.5px;
    line-height: 1.55;
    max-width: 62ch;
  }
  .draft-narration-stats {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 18px;
    border-top: 1px dashed color-mix(in oklab, var(--line) 80%, transparent);
    padding-top: 12px;
  }
  .draft-narration-stats li {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .draft-narration-stat-num {
    font-family: var(--font-mono);
    font-size: 18px;
    font-weight: 500;
    color: var(--ink);
    min-width: 1ch;
    font-variant-numeric: tabular-nums;
  }
  .draft-narration-stat-lbl {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--ink-3);
  }

  /* Per-frame verb pill (e.g. "drawing", "inspecting", "retrying") */
  .draft-slot-verb {
    position: absolute;
    bottom: 8px; left: 8px;
    z-index: 1;
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.62);
    color: #fff;
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    line-height: 1.2;
    pointer-events: none;
  }
  .draft-slot-verb[data-verb="queued"]            { background: rgba(0, 0, 0, 0.45); }
  .draft-slot-verb[data-verb="in_flight"]         { background: var(--accent); }
  .draft-slot-verb[data-verb="inspecting"]        { background: #6b4caa; }
  .draft-slot-verb[data-verb="rejected_retrying"] { background: #c19018; color: #111; }
  .draft-slot-verb[data-verb="failed"]            { background: #b94c4c; }

  /* Master reference */
  .draft-master { margin-bottom: 40px; }
  .draft-master-wrap {
    width: min(360px, 80vw);
    aspect-ratio: 1 / 1;
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .draft-master-wrap img {
    width: 100%; height: 100%;
    display: block; object-fit: cover;
  }
  .draft-master-skel {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    color: var(--ink-3);
    font-family: var(--font-mono);
    font-size: 12px;
    background:
      linear-gradient(90deg,
        var(--paper-2) 0%, var(--paper-3) 40%, var(--paper-2) 80%);
    background-size: 200% 100%;
    animation: draft-shimmer 1.6s ease-in-out infinite;
  }
  @keyframes draft-shimmer {
    0%   { background-position: 100% 0; }
    100% { background-position: -100% 0; }
  }

  /* Frame grid */
  .draft-grid-wrap { margin-bottom: 40px; }
  .draft-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
  }
  .draft-slot {
    position: relative;
    aspect-ratio: 1 / 1;
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
    transition: border-color 200ms var(--ease-out);
  }
  .draft-slot[data-status="queued"]              { opacity: 0.55; }
  .draft-slot[data-status="in_flight"],
  .draft-slot[data-status="inspecting"]          { border-color: var(--accent); }
  .draft-slot[data-status="rejected_retrying"]   { border-color: #d4a017; }
  .draft-slot[data-status="failed"]              { border-color: #b94c4c; opacity: 0.7; }
  .draft-slot[data-status="accepted"]            { border-color: var(--accent); opacity: 1; }
  .draft-slot img {
    width: 100%; height: 100%;
    display: block; object-fit: cover;
  }
  .draft-slot-fill {
    position: absolute; inset: 0;
    background:
      linear-gradient(90deg,
        var(--paper-2) 0%, var(--paper-3) 40%, var(--paper-2) 80%);
    background-size: 200% 100%;
  }
  .draft-slot[data-status="in_flight"] .draft-slot-fill,
  .draft-slot[data-status="inspecting"] .draft-slot-fill {
    animation: draft-shimmer 1.4s ease-in-out infinite;
  }
  .draft-slot[data-status="queued"] .draft-slot-fill { background: var(--paper-2); }
  .draft-slot[data-status="accepted"] .draft-slot-fill { display: none; }
  .draft-slot-num {
    position: absolute;
    top: 8px; right: 8px;
    width: 22px; height: 22px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-family: var(--font-mono);
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1;
  }

  /* Per-frame action overlay (regenerate). Hidden until hover/focus on accepted slots. */
  .draft-slot-actions {
    position: absolute;
    inset: auto 8px 8px 8px;
    display: flex;
    gap: 6px;
    justify-content: flex-end;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out);
    pointer-events: none;
    z-index: 2;
  }
  .draft-slot:hover .draft-slot-actions,
  .draft-slot:focus-within .draft-slot-actions {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }
  .draft-slot-regen-btn {
    appearance: none;
    border: 1px solid rgba(255, 255, 255, 0.4);
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 5px 10px;
    border-radius: 999px;
    cursor: pointer;
    letter-spacing: 0.01em;
    transition: background-color 120ms var(--ease-out), border-color 120ms var(--ease-out);
  }
  .draft-slot-regen-btn:hover { background: rgba(0, 0, 0, 0.8); border-color: rgba(255, 255, 255, 0.6); }
  .draft-slot-regen-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .draft-slot-regen-form {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.82);
    color: #fff;
    display: flex;
    flex-direction: column;
    padding: 10px;
    gap: 8px;
    z-index: 3;
    border-radius: 10px;
  }
  .draft-slot-regen-form textarea {
    flex: 1;
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 6px;
    padding: 6px 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    resize: none;
    line-height: 1.4;
  }
  .draft-slot-regen-form textarea::placeholder { color: rgba(255, 255, 255, 0.55); }
  .draft-slot-regen-form textarea:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .draft-slot-regen-buttons {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  .draft-slot-regen-send,
  .draft-slot-regen-cancel {
    appearance: none;
    border: 1px solid rgba(255, 255, 255, 0.4);
    background: rgba(0, 0, 0, 0.4);
    color: #fff;
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 5px 10px;
    border-radius: 999px;
    cursor: pointer;
  }
  .draft-slot-regen-send {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .draft-slot-regen-send:disabled,
  .draft-slot-regen-cancel:disabled {
    opacity: 0.55;
    cursor: progress;
  }

  /* Pipeline issues */
  .draft-errors-wrap { margin-bottom: 48px; }
  .draft-errors-wrap[hidden] { display: none; }
  .draft-errors-hint {
    margin: 0 0 12px;
    color: var(--ink-3);
    font-size: 13px;
    max-width: 60ch;
  }
  .draft-errors-pre {
    margin: 0;
    padding: 14px;
    background: color-mix(in oklab, var(--accent) 8%, var(--paper-2));
    border: 1px solid color-mix(in oklab, var(--accent) 30%, var(--line));
    border-radius: 12px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--ink-2);
    max-height: 240px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Log */
  .draft-log-wrap { margin-bottom: 48px; }
  .draft-log {
    list-style: none;
    margin: 0;
    padding: 14px;
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 12px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ink-2);
    max-height: 220px;
    overflow-y: auto;
  }
  .draft-log li {
    padding: 4px 0;
    border-bottom: 1px solid color-mix(in oklab, var(--line) 60%, transparent);
  }
  .draft-log li:last-child { border-bottom: none; }
  .draft-log-when {
    color: var(--ink-3);
    margin-right: 8px;
  }

  /* Live agent feed */
  .draft-agent-wrap { margin-bottom: 48px; }
  .draft-agent-dot {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    margin-left: 8px;
    vertical-align: 2px;
    background: var(--ink-3);
  }
  .draft-agent-dot[data-state="live"] {
    background: #3a9d5d;
    box-shadow: 0 0 0 3px color-mix(in oklab, #3a9d5d 25%, transparent);
  }
  .draft-agent-dot[data-state="reconnecting"] { background: #c79a3b; }

  /* Reused detail block */
  .reader-detail {
    display: grid;
    grid-template-columns: 1fr;
    gap: 32px;
    margin: 32px 0;
    max-width: 760px;
  }
  @media (min-width: 760px) {
    .reader-detail { grid-template-columns: 1fr 1fr; }
  }
  .reader-body { margin: 0; color: var(--ink-2); line-height: 1.6; font-size: 15px; }
  .reader-cta { margin-top: 24px; }
  .reader-btn {
    display: inline-flex;
    align-items: center;
    padding: 12px 22px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--paper);
    color: var(--ink);
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
  }
  .reader-btn-primary {
    background: var(--accent);
    color: #fff;
    border-color: transparent;
  }
  .reader-lead {
    color: var(--ink-2);
    font-size: 17px;
    max-width: 56ch;
    margin: 0 0 24px;
  }
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function derivedTitle(story: string): string {
  const first = story.split(/[.\n]/)[0]?.trim() ?? "";
  if (!first) return "A Reel piece";
  return first.length > 80 ? first.slice(0, 79) + "…" : first;
}

function humanStatus(s: string): string {
  switch (s) {
    case "queued": return "Queued";
    case "master_in_flight": return "Drawing the character";
    case "frames_in_flight": return "Rendering frames";
    case "completed": return "Complete";
    case "failed": return "Failed";
    default: return s || "Working";
  }
}
