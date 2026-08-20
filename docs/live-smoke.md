# Live smoke — `HIREAPI_LIVE_ATS=1`

Optional soak. **Not** part of `scripts/test.sh` or GitHub Actions `ci`.
Default adapters stay on fixture HTML. This walk starts a local process with
live ATS on and hits real public Greenhouse / Ashby pages.

## How to run

```bash
unset HIREAPI_LIVE_ATS
bash scripts/live-smoke.sh
```

The script starts `npm start` with:

| env | value |
|---|---|
| `HIREAPI_LIVE_ATS` | `1` |
| `HIREAPI_BOOTSTRAP_KEY` | `hk_test_live_smoke` (override allowed) |
| `HIREAPI_DATABASE` | temp SQLite |
| `PORT` | `38765` unless set |
| `HIREAPI_SMOKE_FORCE_CLOSED` | the job URL, so the *second* by-url is a live 404 |

Override URLs with `HIREAPI_SMOKE_JOB_URL` / `HIREAPI_SMOKE_BOARD_URL`.
LinkedIn and Indeed URLs are rejected.

## Flows

1. `GET /v1/jobs/by-url` — real public Greenhouse or Ashby job.
2. `GET /v1/boards/by-url` — that vendor’s public board (summaries only).
3. Same job URL again after the process 404s it → **200 `closed: true`**, empty Markdown.

Salary is only present when the page has an explicit amount + period. Never estimated.

## This session (2026-08-20)

Ran on this checkout with live flags on. Both vendors walked.

### Ashby (default script)

| # | Request | Result |
|---|---|---|
| 1 | `GET /v1/jobs/by-url?url=https://jobs.ashbyhq.com/linear/1bfdcabe-aa5f-4999-9a6d-b8a824dd779b` | **PASS** — 200, `source=ashby`, title `Account Executive, Enterprise`, company `GTM`, `salary=null` (no explicit range on the page), Markdown 5069 chars, no `<div>` |
| 2 | `GET /v1/boards/by-url?url=https://jobs.ashbyhq.com/linear` | **PASS** — 200, 32 open summaries, `hasFullDescription: false`, first apply URL matches the job |
| 3 | same job URL after forced ATS 404 | **PASS** — 200 `closed: true`, `closedAt=2026-08-20T04:53:35.201Z`, empty description |

### Greenhouse

`HIREAPI_SMOKE_JOB_URL` / `HIREAPI_SMOKE_BOARD_URL` pointed at Discord.

| # | Request | Result |
|---|---|---|
| 1 | `GET /v1/jobs/by-url?url=https://job-boards.greenhouse.io/discord/jobs/8571766002` | **PASS** — 200, `source=greenhouse`, title `Director of Engineering, Safety`, company `Discord`, `salary=null`, Markdown 5200 chars |
| 2 | `GET /v1/boards/by-url?url=https://job-boards.greenhouse.io/discord` | **PASS** — 200, 50 open summaries, first title matches the job |
| 3 | same job URL after forced ATS 404 | **PASS** — 200 `closed: true`, `closedAt=2026-08-20T04:54:04.015Z` |

No LinkedIn / Indeed hosts were requested.

## Parser notes (needed for a real walk)

Live GH job-boards HTML uses `job__title` / `job__description` / `job-post` rows
and 302s gone jobs to `?error=true` instead of HTTP 404. Live Ashby boards put
postings in `window.__appData.jobBoard.jobPostings` (not `__NEXT_DATA__`) and
serve a 200 SPA shell for unknown slugs. Those shapes are now parsed; fixture
HTML still works. CI stays offline.

## Offline gate

`bash scripts/test.sh` must stay green with `HIREAPI_LIVE_ATS` unset. It fails
if that env (or `HIREAPI_SMOKE_FORCE_CLOSED`) is set. Do not add
`scripts/live-smoke.sh` to `.github/workflows/ci.yml`.
