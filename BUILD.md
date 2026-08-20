# HireAPI — Detailed Specification and Build Plan

**Contract:** [SPEC.md](./SPEC.md)  
**Git:** [CONTRIBUTING.md](./CONTRIBUTING.md)

Greenhouse + Ashby first, then Lever. LinkedIn never imported in v1 PRs. Keys `hk_live_`.

---

## 1. Stack

Node 22, Fastify, SQLite. HTML → Markdown via a **pure function** `toMarkdown(html)` with unit tests (strip scripts, keep headings/lists/links).

---

## 2. Vendor adapters

```ts
interface BoardAdapter {
  vendor: "greenhouse" | "ashby" | "lever";
  matchJobUrl(url: string): boolean;
  matchBoardUrl(url: string): boolean;
  fetchJob(url: string): Promise<Job>;
  fetchBoard(url: string): Promise<JobSummary[]>;
}
```

Router: first matching adapter wins. None → `unsupported_board`.

**Board list returns summaries only** (`hasFullDescription: false`). Full Markdown only on `by-url`.

---

## 3. Closed jobs

If a known job URL 404s or board omits it:

- Persist `closed=1`, `closed_at`
- `GET by-url` returns **200** with `closed: true` (SPEC pick) so monitors are not false-alerted as transport errors
- Do not keep serving old description as open

---

## 4. Salary

Parse only explicit text (`$120,000–$140,000 a year`). If ambiguous → `salary: null`. Never estimate from title/level.

---

## 5. Fixtures

20 boards: 8 GH, 7 Ashby, 5 Lever. Snapshot HTML in `tests/fixtures/boards/`. Parser tests do not network.

---

## 6. PR plan

### PR 1: Skeleton + keys + Job types + toMarkdown
- **Files:** types, `src/markdown.ts`, tests/markdown.test.ts
- **Dependencies:** None

### PR 2: Greenhouse + Ashby by-url
- **Files:** adapters/greenhouse, adapters/ashby, core/jobs.ts, routes, fixtures, tests
- **Dependencies:** PR 1
- **Acceptance:** SPEC 1–2, 5, 7

### PR 3: boards/by-url summaries + closed lifecycle
- **Files:** core/boards.ts, db jobs table, tests/closed.test.ts
- **Dependencies:** PR 2
- **Acceptance:** SPEC 3–4

### PR 4: Lever adapter
- **Files:** adapters/lever, more fixtures
- **Dependencies:** PR 3

### PR 5: company id + search over ingested
- **Files:** core/search.ts — **ingested only**, no Indeed
- **Dependencies:** PR 3
- **Acceptance:** SPEC 6

### PR 6: MCP
- **Files:** `src/mcp/*`, `llms.txt`, `tests/mcp.test.ts`
- **Dependencies:** PR 5
- **Tools:** get_job, list_board, search_jobs

### PR 7: live ATS fetch (env-gated)
- **Files:** `src/adapters/live.ts`, `src/adapters/transport.ts`, `src/adapters/index.ts`, tests/live.test.ts
- **Dependencies:** PR 6
- **Acceptance:** `HIREAPI_LIVE_ATS=1` GETs GH/Ashby/Lever board+job URLs; default remains fixtures; CI stays offline

### PR 8: Dockerfile + one-VPS runbook
- **Files:** `Dockerfile`, `.env.example`, `deploy/runbook.md`
- **Dependencies:** PR 7
- **Acceptance:** Node 22, non-root, listen on `$PORT`; live ATS stays off until the operator sets `HIREAPI_LIVE_ATS`; CI stays offline

No LinkedIn files in this plan. Indeed = future isolated package.
