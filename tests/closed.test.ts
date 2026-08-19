import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createAshbyAdapter } from "../src/adapters/ashby.js";
import { createFixtureFetchPage } from "../src/adapters/fixtures.js";
import { createGreenhouseAdapter } from "../src/adapters/greenhouse.js";
import type { FetchPage, FetchedPage } from "../src/adapters/transport.js";
import { buildApp } from "../src/app.js";
import { getBoardByUrl } from "../src/core/boards.js";
import { getJobByUrl } from "../src/core/jobs.js";
import { getJobByApplyUrl, getJobById } from "../src/core/store.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode, Job, JobSummary } from "../src/types.js";

const TEST_KEY = "hk_test_boards_closed";
const GH_STRIPE_JOB = "https://boards.greenhouse.io/stripedemo/jobs/4000001";
const GH_STRIPE_BOARD = "https://boards.greenhouse.io/stripedemo";
const GH_STRIPE_EMPTY = "https://boards.greenhouse.io/stripedemo-empty";
const GH_MISSING_BOARD = "https://boards.greenhouse.io/missingboard";
const GH_UNKNOWN_CLOSED = "https://boards.greenhouse.io/stripedemo/jobs/4099999";
const ASHBY_LINEAR_BOARD = "https://jobs.ashbyhq.com/lineardemo";
const ASHBY_LINEAR_JOB = "https://jobs.ashbyhq.com/lineardemo/staff-product-engineer";

function assertSummary(job: JobSummary): void {
  assert.match(job.id, /^job_/);
  assert.ok(job.title.length > 0);
  assert.ok(job.company.name.length > 0);
  assert.ok(job.applyUrl.startsWith("http"));
  assert.equal(job.hasFullDescription, false);
  assert.equal("descriptionMarkdown" in job, false);
}

function withJobOverride(url: string, page: FetchedPage): FetchPage {
  const base = createFixtureFetchPage();
  return async (requested) => {
    if (requested === url || requested.replace(/\/+$/, "") === url.replace(/\/+$/, "")) {
      return page;
    }
    return base(requested);
  };
}

test("Greenhouse board fixture returns ≥1 summary job with no full description", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const jobs = await getBoardByUrl(GH_STRIPE_BOARD, db);
  assert.ok(jobs.length >= 1);
  for (const job of jobs) {
    assertSummary(job);
    assert.equal(job.closed, false);
  }
  assert.equal(
    jobs.some((job) => job.title === "Staff Software Engineer"),
    true,
  );
  assert.equal(jobs[0]?.applyUrl.includes("greenhouse.io"), true);
});

test("Ashby board fixture returns ≥1 summary job", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const jobs = await getBoardByUrl(ASHBY_LINEAR_BOARD, db);
  assert.ok(jobs.length >= 1);
  assertSummary(jobs[0]!);
  assert.equal(jobs.some((job) => job.applyUrl === ASHBY_LINEAR_JOB), true);
});

test("GET /v1/boards/by-url charges 1 credit per open job returned", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/boards/by-url?url=${encodeURIComponent(GH_STRIPE_BOARD)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: JobSummary[];
    meta: { creditsCharged: number; nextCursor: string | null };
  };
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length >= 1);
  assert.equal(body.data[0]?.hasFullDescription, false);
  assert.equal(body.meta.creditsCharged, body.data.length);
  assert.equal(body.meta.nextCursor, null);

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(
    (me.json() as { data: { creditsRemaining: number } }).data.creditsRemaining,
    100 - body.data.length,
  );
});

test("empty open board returns [] and charges 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/boards/by-url?url=${encodeURIComponent(GH_STRIPE_EMPTY)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: JobSummary[];
    meta: { creditsCharged: number };
  };
  assert.deepEqual(body.data, []);
  assert.equal(body.meta.creditsCharged, 0);

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal((me.json() as { data: { creditsRemaining: number } }).data.creditsRemaining, 100);
});

test("unknown vendor board is 422 unsupported_board and 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/boards/by-url?url=${encodeURIComponent("https://jobs.lever.co/demo")}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 422);
  const body = response.json() as {
    error: { code: ErrorCode };
    meta: { creditsCharged: number };
  };
  assert.equal(body.error.code, "unsupported_board");
  assert.equal(body.meta.creditsCharged, 0);
});

test("missing board is 404 board_not_found and 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/boards/by-url?url=${encodeURIComponent(GH_MISSING_BOARD)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 404);
  const body = response.json() as {
    error: { code: ErrorCode };
    meta: { creditsCharged: number };
  };
  assert.equal(body.error.code, "board_not_found");
  assert.equal(body.meta.creditsCharged, 0);
});

test("known job URL that 404s returns 200 with closed: true and persists closed_at", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const adapters = [createGreenhouseAdapter(createFixtureFetchPage())];
  const open = await getJobByUrl(GH_STRIPE_JOB, adapters, db);
  assert.equal(open.closed, false);
  assert.ok(open.descriptionMarkdown.length > 0);
  db.prepare("UPDATE jobs SET fetched_at = ? WHERE apply_url = ?").run(
    "2000-01-01T00:00:00.000Z",
    open.applyUrl,
  );

  const closedAdapters = [
    createGreenhouseAdapter(
      withJobOverride(GH_STRIPE_JOB, { url: GH_STRIPE_JOB, status: 404, body: "gone" }),
    ),
  ];
  const closed = await getJobByUrl(GH_STRIPE_JOB, closedAdapters, db);
  assert.equal(closed.closed, true);
  assert.equal(closed.descriptionMarkdown, "");
  assert.equal(closed.id, open.id);

  const row = db
    .prepare<[string], { closed: number; closed_at: string | null; description_markdown: string }>(
      "SELECT closed, closed_at, description_markdown FROM jobs WHERE apply_url = ?",
    )
    .get(open.applyUrl);
  assert.equal(row?.closed, 1);
  assert.ok(row?.closed_at);
  assert.equal(row?.description_markdown, "");
});

test("GET /v1/jobs/by-url for a known closed job is 200 closed, 1 credit, not 404", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const app = await buildApp({ db, bootstrapKey: TEST_KEY });
  after(() => app.close());

  const first = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent(GH_STRIPE_JOB)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(first.statusCode, 200);
  assert.equal((first.json() as { data: Job }).data.closed, false);

  db.prepare("UPDATE jobs SET fetched_at = ? WHERE apply_url = ?").run(
    "2000-01-01T00:00:00.000Z",
    GH_STRIPE_JOB,
  );

  const adapters = [
    createGreenhouseAdapter(
      withJobOverride(GH_STRIPE_JOB, { url: GH_STRIPE_JOB, status: 404, body: "gone" }),
    ),
  ];
  const closed = await getJobByUrl(GH_STRIPE_JOB, adapters, db);
  assert.equal(closed.closed, true);

  const second = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent(GH_STRIPE_JOB)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(second.statusCode, 200);
  const body = second.json() as { data: Job; meta: { creditsCharged: number } };
  assert.equal(body.data.closed, true);
  assert.equal(body.data.descriptionMarkdown, "");
  assert.equal(body.meta.creditsCharged, 1);
});

test("unknown 404 job URL still surfaces job_closed (never ingested)", async () => {
  await assert.rejects(() => getJobByUrl(GH_UNKNOWN_CLOSED), {
    name: "HireError",
    code: "job_closed",
  });
});

test("board omit marks previously ingested job closed and strips the old description", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const adapters = [createGreenhouseAdapter(createFixtureFetchPage())];
  const first = await getBoardByUrl(GH_STRIPE_BOARD, db, adapters);
  assert.ok(first.some((job) => job.applyUrl === GH_STRIPE_JOB));
  const stored = getJobByApplyUrl(db, GH_STRIPE_JOB);
  assert.equal(stored?.closed, false);

  const emptyAdapters = [
    createGreenhouseAdapter(
      withJobOverride(GH_STRIPE_BOARD, {
        url: GH_STRIPE_BOARD,
        status: 200,
        body: `<html><body><h1 class="company-name">StripeDemo</h1></body></html>`,
      }),
    ),
  ];
  const second = await getBoardByUrl(GH_STRIPE_BOARD, db, emptyAdapters);
  assert.deepEqual(second, []);
  const closed = getJobByApplyUrl(db, GH_STRIPE_JOB);
  assert.equal(closed?.closed, true);
  assert.equal(closed?.descriptionMarkdown, "");
  const row = db
    .prepare<[string], { closed_at: string | null }>(
      "SELECT closed_at FROM jobs WHERE apply_url = ?",
    )
    .get(GH_STRIPE_JOB);
  assert.ok(row?.closed_at);
});

test("jobs table is created by migrations", () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  const names = cols.map((col) => col.name);
  assert.ok(names.includes("closed"));
  assert.ok(names.includes("closed_at"));
  assert.ok(names.includes("apply_url"));
  assert.ok(names.includes("description_markdown"));
});

test("GET /v1/boards/by-url without bearer is 401 with 0 credits", async () => {
  const app = await buildApp();
  after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: `/v1/boards/by-url?url=${encodeURIComponent(GH_STRIPE_BOARD)}`,
  });
  assert.equal(response.statusCode, 401);
  assert.equal((response.json() as { error: { code: string } }).error.code, "unauthorized");
  assert.equal((response.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});

test("board ingest then job by-url still returns full Markdown for an open posting", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  await getBoardByUrl(GH_STRIPE_BOARD, db);
  const summary = getJobById(db, "job_greenhouse_4000001");
  assert.equal(summary?.descriptionMarkdown, "");

  db.prepare("UPDATE jobs SET fetched_at = ? WHERE id = ?").run(
    "2000-01-01T00:00:00.000Z",
    "job_greenhouse_4000001",
  );
  const job = await getJobByUrl(GH_STRIPE_JOB, undefined, db);
  assert.equal(job.closed, false);
  assert.ok(job.descriptionMarkdown.includes("Build payments APIs"));
  assert.equal(job.descriptionMarkdown.includes("<div>"), false);
});

test("Ashby adapter fetchBoard is fixture-only (no live host)", async () => {
  const adapter = createAshbyAdapter(createFixtureFetchPage());
  const jobs = await adapter.fetchBoard(ASHBY_LINEAR_BOARD);
  assert.ok(jobs.length >= 1);
  assert.equal(jobs[0]?.hasFullDescription, false);
});
