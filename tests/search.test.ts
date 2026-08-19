import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../src/app.js";
import { createKey } from "../src/billing/keys.js";
import { getBoardByUrl } from "../src/core/boards.js";
import { getCompany, listCompanyJobs } from "../src/core/companies.js";
import { getJobByUrl } from "../src/core/jobs.js";
import { searchIngestedJobs } from "../src/core/search.js";
import { closeStoredJob, findStoredJob } from "../src/core/store.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode, Job, JobSummary } from "../src/types.js";

const TEST_KEY = "hk_test_company_search";
const GH_BOARD = "https://boards.greenhouse.io/stripedemo";
const GH_STRIPE = "https://boards.greenhouse.io/stripedemo/jobs/4000001";
const ASHBY_BOARD = "https://jobs.ashbyhq.com/lineardemo";
const LEVER_BOARD = "https://jobs.lever.co/netflixdemo";
const STRIPE_COMPANY = "co_greenhouse_stripedemo";

function assertSummary(row: JobSummary): void {
  assert.match(row.id, /^job_/);
  assert.ok(row.title.length > 0);
  assert.ok(row.company.name.length > 0);
  assert.match(row.company.id ?? "", /^co_/);
  assert.ok(row.applyUrl.startsWith("http"));
  assert.equal(row.hasFullDescription, false);
  assert.equal(row.closed, false);
  assert.equal("descriptionMarkdown" in row, false);
}

test("ingesting a board creates a stable company id on every summary", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const board = await getBoardByUrl(GH_BOARD, db);
  assert.ok(board.jobs.length >= 1);
  for (const row of board.jobs) {
    assert.equal(row.company.id, STRIPE_COMPANY);
    assert.equal(row.company.name, "StripeDemo");
  }
  const company = getCompany(db, STRIPE_COMPANY);
  assert.ok(company);
  assert.equal(company.name, "StripeDemo");
  assert.equal(company.boardUrl, GH_BOARD);

  const again = await getBoardByUrl(GH_BOARD, db);
  assert.equal(again.jobs[0]?.company.id, STRIPE_COMPANY);
});

test("getJobByUrl with a db assigns the same company id as the board", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  await getBoardByUrl(GH_BOARD, db);
  const job = await getJobByUrl(GH_STRIPE, { db });
  assert.equal(job.company.id, STRIPE_COMPANY);
  assert.equal(job.company.name, "StripeDemo");
});

test("listCompanyJobs returns ingested open summaries only", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  await getBoardByUrl(GH_BOARD, db);
  const page = listCompanyJobs(db, STRIPE_COMPANY);
  assert.ok(page.jobs.length >= 1);
  for (const row of page.jobs) {
    assertSummary(row);
    assert.equal(row.company.id, STRIPE_COMPANY);
  }
  assert.ok(page.jobs.some((row) => row.title === "Staff Software Engineer"));
  assert.equal(page.nextCursor, null);
});

test("searchIngestedJobs hits an ingested title and skips closed jobs", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  assert.deepEqual(searchIngestedJobs(db, { q: "Staff" }).jobs, []);

  await getBoardByUrl(GH_BOARD, db);
  await getBoardByUrl(ASHBY_BOARD, db);
  await getBoardByUrl(LEVER_BOARD, db);

  const hits = searchIngestedJobs(db, { q: "Staff" });
  assert.ok(hits.jobs.length >= 1);
  assert.ok(hits.jobs.every((row) => /staff/i.test(row.title)));
  for (const row of hits.jobs) {
    assertSummary(row);
  }

  const ios = searchIngestedJobs(db, { q: "iOS Engineer" });
  assert.equal(ios.jobs.length, 1);
  assert.equal(ios.jobs[0]?.title, "iOS Engineer");
  assert.equal(ios.jobs[0]?.company.id, "co_lever_netflixdemo");

  const sf = searchIngestedJobs(db, { location: "San Francisco" });
  assert.ok(sf.jobs.some((row) => row.title === "Staff Software Engineer"));

  const ghOnly = searchIngestedJobs(db, { source: "greenhouse" });
  assert.ok(ghOnly.jobs.length >= 1);
  assert.ok(ghOnly.jobs.every((row) => row.company.id?.startsWith("co_greenhouse_")));

  const remote = searchIngestedJobs(db, { remote: "true" });
  assert.ok(remote.jobs.length >= 1);
  assert.ok(remote.jobs.every((row) => row.remote === true));

  const stored = findStoredJob(db, GH_STRIPE);
  assert.ok(stored);
  closeStoredJob(db, stored.job.id, new Date("2026-03-02T00:00:00.000Z"));
  const afterClose = searchIngestedJobs(db, { q: "Staff Software Engineer" });
  assert.equal(
    afterClose.jobs.some((row) => row.id === stored.job.id),
    false,
  );
});

test("search source=indeed / linkedin is source_disabled", () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  assert.throws(() => searchIngestedJobs(db, { source: "indeed" }), {
    name: "HireError",
    code: "source_disabled",
  });
  assert.throws(() => searchIngestedJobs(db, { source: "linkedin" }), {
    name: "HireError",
    code: "source_disabled",
  });
});

test("unknown company id is not_found", () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  assert.throws(() => listCompanyJobs(db, "co_missing"), {
    name: "HireError",
    code: "not_found",
  });
});

test("GET /v1/search ingested title → 200 hit, 1 credit per hit", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, { secret: TEST_KEY });
  await getBoardByUrl(GH_BOARD, db);
  const app = await buildApp({ db });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=Staff",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: JobSummary[];
    meta: { creditsCharged: number; cached: boolean; requestId: string };
  };
  assert.ok(body.data.length >= 1);
  assert.ok(body.data.some((row) => row.title === "Staff Software Engineer"));
  assert.equal(body.meta.creditsCharged, body.data.length);
  for (const row of body.data) {
    assertSummary(row);
  }
  assert.match(body.meta.requestId, /^req_/);
});

test("GET /v1/search empty store is 200 data:[] and 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=Staff",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: JobSummary[]; meta: { creditsCharged: number } };
  assert.deepEqual(body.data, []);
  assert.equal(body.meta.creditsCharged, 0);
});

test("GET /v1/search Indeed/LinkedIn is 422 source_disabled, 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  for (const source of ["indeed", "linkedin"]) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/search?source=${source}`,
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    assert.equal(response.statusCode, 422);
    const body = response.json() as {
      error: { code: ErrorCode };
      meta: { creditsCharged: number };
    };
    assert.equal(body.error.code, "source_disabled");
    assert.equal(body.meta.creditsCharged, 0);
  }
});

test("GET /v1/search without bearer is 401 with 0 credits", async () => {
  const app = await buildApp();
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=Staff",
  });
  assert.equal(response.statusCode, 401);
  assert.equal((response.json() as { error: { code: string } }).error.code, "unauthorized");
  assert.equal((response.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});

test("GET /v1/companies/{id}/jobs returns the ingested page, 1 credit", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, { secret: TEST_KEY });
  await getBoardByUrl(GH_BOARD, db);
  const app = await buildApp({ db });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/companies/${STRIPE_COMPANY}/jobs`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: JobSummary[];
    meta: { creditsCharged: number };
  };
  assert.ok(body.data.length >= 1);
  assert.equal(body.meta.creditsCharged, 1);
  for (const row of body.data) {
    assertSummary(row);
    assert.equal(row.company.id, STRIPE_COMPANY);
  }
});

test("GET /v1/companies/{id}/jobs unknown id is 404 not_found, 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/companies/co_missing/jobs",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 404);
  const body = response.json() as {
    error: { code: ErrorCode };
    meta: { creditsCharged: number };
  };
  assert.equal(body.error.code, "not_found");
  assert.equal(body.meta.creditsCharged, 0);
});

test("GET /v1/jobs/by-url persisted job includes company.id", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, { secret: TEST_KEY });
  const app = await buildApp({ db });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent(GH_STRIPE)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: Job; meta: { creditsCharged: number } };
  assert.equal(body.data.company.id, STRIPE_COMPANY);
  assert.equal(body.meta.creditsCharged, 1);
});

test("zero-credit key cannot search hits or list a company page", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, { secret: "hk_test_broke_search", credits: 0 });
  await getBoardByUrl(GH_BOARD, db);
  const app = await buildApp({ db });
  after(() => app.close());

  const search = await app.inject({
    method: "GET",
    url: "/v1/search?q=Staff",
    headers: { authorization: "Bearer hk_test_broke_search" },
  });
  assert.equal(search.statusCode, 402);
  assert.equal((search.json() as { error: { code: string } }).error.code, "payment_required");
  assert.equal((search.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);

  const company = await app.inject({
    method: "GET",
    url: `/v1/companies/${STRIPE_COMPANY}/jobs`,
    headers: { authorization: "Bearer hk_test_broke_search" },
  });
  assert.equal(company.statusCode, 402);
  assert.equal((company.json() as { error: { code: string } }).error.code, "payment_required");
});
