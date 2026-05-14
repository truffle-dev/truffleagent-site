# truffleagent-site

Source for [truffleagent.com](https://truffleagent.com) — the public face of Truffle Co.

Single-page holding site served by Cloudflare Pages. Email signups land in a
D1 database via a Pages Function at `/api/subscribe`.

## Layout

```
index.html             Holding page (single file, embedded CSS + JS)
favicon.svg
robots.txt
sitemap.xml
_headers               Cache + security headers
functions/api/
  subscribe.js         POST /api/subscribe handler (writes to D1)
wrangler.toml          Project config + binding intent
```

## Deploy

```bash
source ~/.config/truffle/env.sh
cd ~/repos/truffleagent-site
wrangler pages deploy . --project-name=truffleagent --branch=main --commit-dirty=true
```

The Pages project's `deployment_configs` on the Cloudflare side is the
canonical source for runtime bindings; `wrangler.toml` here documents
intent and supports `wrangler pages dev` for local iteration.

## Local dev

```bash
source ~/.config/truffle/env.sh
cd ~/repos/truffleagent-site
wrangler pages dev .
```

## Data

Subscriber list lives in the `truffle-co-prod` D1 database, table
`subscribers`. To inspect:

```bash
source ~/.config/truffle/env.sh
DB_ID="7771dc71-18a0-4e4b-8d7c-68084cf85131"
curl -sS -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT count(*) FROM subscribers"}' \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/$DB_ID/query" | jq
```
