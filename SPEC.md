# HireAPI — Product Development Spec

**Version:** 1.0  
**Status:** Ready to build  
**Repo:** https://github.com/tangpingqingwa/hireapi  
**Sources v1:** Greenhouse, Ashby, Lever public boards  
**Not on homepage until soak:** Indeed, LinkedIn

One schema for public job posts. We are not a job board.

---

## 1. Product statement

URL or board in → title, company, location, remote flag, salary if present, description Markdown, apply URL.

One-line pitch: **Parse any Greenhouse/Ashby/Lever board into one JSON schema.**

ATS first (cleaner ToS, happier cache). Aggregator search is the upsell.

---

## 2. Goals and non-goals

### Goals

- `GET /v1/jobs/by-url` one record.
- `GET /v1/boards/by-url` paginated jobs, vendor hidden.
- Description is Markdown, not HTML junk.
- Board 404 → jobs marked `closed`, not ghosted forever.
- LinkedIn stays off marketing until 7 green CI days **and** legal review.

### Non-goals

- Apply-on-behalf, Easy Apply bots, outreach sequencers.
- Resume parsing.
- Becoming a job board (no hosted apply).
- Implied LinkedIn partnership.

---

## 3. Auth and envelope

Bearer `hk_live_...`.

| code | HTTP | meaning |
|---|---|---|
| `unsupported_board` | 422 | vendor we do not parse |
| `job_closed` | 404 | posting gone |
| `board_not_found` | 404 | |
| `source_disabled` | 422 | LinkedIn/Indeed requested but not enabled |

---

## 4. Endpoints

### 4.1 `GET /v1/jobs/by-url`

**Credits:** 1.

Accepts a Greenhouse/Ashby/Lever job URL.

`data`:

```ts
{
  id: string                 // job_...
  source: "greenhouse" | "ashby" | "lever" | "indeed" | "linkedin"
  sourceJobId: string | null
  title: string
  company: { name: string, id: string | null }
  locations: Array<{ raw: string, city: string | null, region: string | null, country: string | null }>
  remote: boolean | null
  employmentType: "full_time" | "part_time" | "contract" | "intern" | "other" | null
  salary: {
    min: number | null
    max: number | null
    currency: string | null
    period: "year" | "hour" | "month" | null
    raw: string | null
  } | null
  descriptionMarkdown: string
  applyUrl: string
  postedAt: string | null
  closed: boolean
  closedAt: string | null
  fetchedAt: string
}
```

Salary only if present. Do not estimate.

A **known** job that 404s or is omitted from its board is **200** with `closed: true` and empty `descriptionMarkdown` — not HTTP 404. An unknown (never ingested) job URL that 404s is `404 job_closed`.

### 4.2 `GET /v1/boards/by-url`

**Credits:** 1 per **open** job returned (min 1 if the board exists and has ≥1 open job). Empty open board: 0 credits, `data: []`.

Query: `url` (required), `cursor` (optional). v1 returns the full open list in one page; `cursor` is accepted for forward-compat and unused when the board fits one page.

`data` is **summary jobs** only:

```ts
{
  id: string
  title: string
  company: { name: string, id: string | null }
  locations: Array<{ raw: string, city: string | null, region: string | null, country: string | null }>
  remote: boolean | null
  applyUrl: string
  closed: boolean
  hasFullDescription: false
}
```

No `descriptionMarkdown` on this list. Full Markdown is only on `GET /v1/jobs/by-url`. Closed jobs are omitted from `data` (they are persisted, not ghosted).

Unknown vendor → `422 unsupported_board`. Board host matches but the board is gone → `404 board_not_found`. LinkedIn/Indeed → `422 source_disabled`.

### 4.3 `GET /v1/companies/{id}/jobs`

**Credits:** 1 / page. `id` is our company id created when a board is first ingested.

### 4.4 `GET /v1/search`

**Credits:** 1 / hit. Query: `q`, `location`, `source`, `remote`, `cursor`.

v1 search = our ingested boards, **not** a live Indeed scrape. Homepage must not say “search Indeed” until that adapter exists.

### 4.5 Control plane

`/v1/me`, `/v1/usage`, `/healthz`.

---

## 5. Lifecycle

When a known job URL 404s or the board omits it:

- Persist `closed: true`, `closedAt`.
- `GET /v1/jobs/by-url` returns **200** with `closed: true` and empty `descriptionMarkdown` (not `404 job_closed`) so monitors are not false-alerted as transport errors.
- A URL we have never ingested that 404s is still `404 job_closed`.
- Do not keep serving the old description as if the job were open.

Cache open **full** jobs 24h or until closed. Board lists are not cached, so a refresh can close omitted rows.

---

## 6. Billing

| Plan | Price | Credits |
|---|---|---|
| Free | $0 | 100 once |
| Monthly | $19 | 3,000 |
| Annual | $190 | 3,000 / mo |

Top-up $8 / 1k.

---

## 7. Fixtures

20 real public boards (mix of GH / Ashby / Lever). Snapshot HTML. Parser unit tests. A board redesign fails CI.

---

## 8. MCP

`get_job`, `list_board`, `search_jobs`.

Skill: apply links go to source; we do not apply; salary may be null; LinkedIn not available.

SEO: `How to parse a Greenhouse board`, `Does Indeed still give API keys?`

---

## 9. Acceptance

| # | Case | Expected |
|---|---|---|
| 1 | Greenhouse job URL | typed record, Markdown description |
| 2 | Ashby job URL | same schema |
| 3 | Lever board URL | ≥1 summary job |
| 4 | Closed job | `closed: true` or 404 job_closed, not a live ghost |
| 5 | Unknown vendor URL | 422 unsupported_board, 0 credit |
| 6 | Search ingested title | hit |
| 7 | HTML tags stripped from Markdown | no `<div>` |

Dogfood: personal “companies I would join” refreshes daily via this API only.

---

## 10. Milestones

**M1:** GH + Ashby by-url + Markdown cleaner + 20 fixtures.  
**M2:** Lever; boards/by-url; keys; $19.  
**M3:** company id + search over ingested.  
**M4:** MCP + SEO.  
**M5:** Indeed adapter isolated. LinkedIn only after legal + soak.

Launch = M2.

---

## 11. Legal

Read-only. No credential stuffing. Customer ToS: no spam, no apply bots. Isolate future LinkedIn adapter in a separate process so a ban cannot take ATS down.

## 12. Git collaboration (normative)

Development is GitHub trunk-based. **`main` is always cloneable, buildable, and testable.**

| Rule | Requirement |
|---|---|
| Integration branch | `main` only. No long-lived `develop`. |
| How code lands | Pull request into `main`. No direct push. |
| Required check | GitHub Actions workflow `ci` (job id `ci`) must be green. |
| Local / CI test | `bash scripts/test.sh` — offline, no production secrets. |
| Branch names | `feat/` `fix/` `docs/` `chore/` `test/` + short slug. |
| Merge | Squash. Delete the head branch. |
| Broken `main` | Treat as an incident. Fix on `fix/…` via PR. |

Full process: [CONTRIBUTING.md](./CONTRIBUTING.md).

Implementation plan (stack, modules, PR DAG): [BUILD.md](./BUILD.md).

Until there is an application binary, `scripts/test.sh` still has to pass: contract files exist, SPEC/CONTRIBUTING agree, no tracked secrets. Adding a server or CLI means **extending** that script with unit/contract tests. Live upstream calls are optional and must not be required for `main` to stay green.
