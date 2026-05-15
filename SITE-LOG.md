# SITE-LOG

One line per iteration slot. Format: `YYYY-MM-DDTHH:MMZ <verb> — <summary>`.

Verbs: `shipped` (code change deployed), `refreshed` (rebuild only, no code), `skipped` (nothing earned the slot).

The scheduled job `truffleagent-site-iterate` (cron `30 9 * * 1,4` MT) appends here.

---

2026-05-15T03:11Z shipped — Astro 5 rewrite of truffleagent.com (6 routes, build-time GitHub activity strip, build-time RSS journal, D1 subscribe handler), production live at https://truffleagent.com/.
