# Deploy ritual for truffleagent.com

The site is a static Astro build deployed to Cloudflare Pages via Wrangler.
The project is **not** Git-connected on Pages — pushes do not deploy.
Only `wrangler pages deploy dist` ships code to production.

This is the ritual. Follow it every time. No shortcuts on /spin/.

## 0. Prep the shell

```bash
source ~/.config/truffle/env.sh   # cloudflare token, node, wrangler
cd ~/repos/truffleagent-site
```

If the phantom container is near its pid ceiling, prefix the build with
`GOMAXPROCS=1 RAYON_NUM_THREADS=1` and close any extra browser tabs first.

## 1. Local dev preview (always)

```bash
npm run build
npx astro preview --port 4321
```

Open `http://localhost:4321/spin/` and run the smoke pass below before
touching wrangler. A local 200 with zero console errors is the floor.

### Smoke pass for /spin/

Every edit that touches `src/pages/spin/**` must clear all six checks:

1. **Wheel spin works.** Click the center button. The wheel rotates and
   a winner is announced. The `removeBtn` shows only in non-Eliminate
   modes. Confetti fires; no `Uncaught` in console.
2. **Persistence survives reload.** Add an entry, refresh. Entry is
   still there. `spinwheel:v1` exists in localStorage.
3. **Preset cards launch instantly.** Click each of the five cards at
   the bottom of `/spin/`. Each one creates a wheel in-place (no
   round-trip to a landing page), and the wheel name in the picker
   updates to match.
4. **All five preset landing pages load.** Visit `/spin/yes-no/`,
   `/spin/coin-flip/`, `/spin/standup-order/`, `/spin/restaurant-picker/`,
   `/spin/birthday-month/`. Each renders headers and CTAs. Click the
   primary CTA on each — `/spin/?w=<payload>` loads with the right
   entries.
5. **Mobile width is clean.** DevTools → 390x844 (iPhone 13). The wheel
   labels stay legible at N=30 entries. No horizontal overflow.
6. **JSON-LD parses.** View source, copy each `application/ld+json`
   block into a JSON validator. WebApplication and FAQPage must parse
   cleanly. Canonical URL must be production.

If any check fails, fix locally and rebuild. Do NOT proceed to step 2.

## 2. Preview deploy

```bash
wrangler pages deploy dist --project-name=truffleagent --branch=preview \
  --commit-dirty=true --commit-message="preview: $(git rev-parse --short HEAD) $(date -u +%Y-%m-%dT%H:%MZ)"
```

Wrangler prints a `*.truffleagent.pages.dev` URL. Open it. Repeat the
smoke pass from step 1 — this is the first time you'll see the build
on real CDN with real headers (SW caching, COOP/COEP, manifest mime).

Service worker fact: the `/spin/sw.js` is scoped to `/spin/`. On the
preview URL host, the SW may serve stale assets from a prior preview.
Hard-refresh once (Cmd-Shift-R / Ctrl-Shift-R) before judging.

## 3. Production deploy

Only when the preview deploy smoke pass is clean.

```bash
wrangler pages deploy dist --project-name=truffleagent --branch=main \
  --commit-dirty=true --commit-message="prod: $(git rev-parse --short HEAD)"
```

Then within 60 seconds:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://truffleagent.com/spin/
curl -s -o /dev/null -w "%{http_code}\n" https://truffleagent.com/spin/yes-no/
curl -s -o /dev/null -w "%{http_code}\n" https://truffleagent.com/spin/coin-flip/
curl -s -o /dev/null -w "%{http_code}\n" https://truffleagent.com/spin/standup-order/
curl -s -o /dev/null -w "%{http_code}\n" https://truffleagent.com/spin/restaurant-picker/
curl -s -o /dev/null -w "%{http_code}\n" https://truffleagent.com/spin/birthday-month/
```

All six must return `200`. Anything else is a regression. Roll back
immediately via the Cloudflare Pages dashboard (Deployments → previous
production deploy → "Rollback to this deployment"). Pages keeps a
30-day deploy history.

## 4. Post-deploy verify in a real browser

Open https://truffleagent.com/spin/ in a real browser. Verify:

- Page loads under 2 s on a warm cache.
- Zero console errors.
- Five preset cards at the bottom each launch a wheel in-place.
- Spin once; winner modal renders correctly.
- Switch a mode chip; layout doesn't shift.

## What can silently break

Watch list, ordered by how often it has bitten us:

1. **Hardcoded canonical and embed URLs** point to `https://truffleagent.com`.
   These survive prod but a staging build looks correct locally and then
   loads OG cards from prod. Don't be surprised if a preview
   share-link breaks; this is by design.
2. **`spinwheel:v1` localStorage key** has never been versioned up.
   Changing entry shape without a migration silently corrupts saved
   wheels. If you change the entry schema, bump the key.
3. **PWA service worker at `/spin/sw.js`** caches aggressively. After
   a deploy, an existing user's first load may still render the old
   bundle until the SW updates. The `sw.js` revision in the manifest
   forces a refresh; bump it whenever index.astro changes.
4. **`pids.max=256`** on the phantom container. esbuild and rayon
   spawn many workers; if pid count exceeds the cap during build, the
   build fails partway with EAGAIN and the resulting `dist/` is
   incomplete. Prefix with `GOMAXPROCS=1 RAYON_NUM_THREADS=1` and
   close browser tabs before building when the container is hot.
5. **Cloudflare Pages project name is `truffleagent`** (no hyphen, no
   `-site` suffix). The repo is `truffleagent-site`; the project is
   `truffleagent`. Get the wrangler arg wrong and the deploy silently
   ships to the wrong project.

## Rollback in 30 seconds

```bash
# From the Cloudflare dashboard:
# Pages → truffleagent → Deployments → previous "Production" row → ⋮ →
#   "Rollback to this deployment"
```

Pages re-points the alias instantly; no rebuild needed.
