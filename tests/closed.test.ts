import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAshbyAdapter } from "../src/adapters/ashby.js";
import { createGreenhouseAdapter } from "../src/adapters/greenhouse.js";
import { createLeverAdapter } from "../src/adapters/lever.js";
import type { FetchPage } from "../src/adapters/transport.js";
import { buildApp } from "../src/app.js";
import { getBoardByUrl } from "../src/core/boards.js";
import { getJobByUrl } from "../src/core/jobs.js";
import { findStoredJob, OPEN_JOB_CACHE_MS, upsertJobSummary } from "../src/core/store.js";
import { openDatabase } from "../src/db.js";
import type { BoardAdapter, ErrorCode, Job } from "../src/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures/boards");
const GH_STRIPE = "https://boards.greenhouse.io/stripedemo/jobs/4000001";
const GH_ANALYST = "https://boards.greenhouse.io/stripedemo/jobs/4000011";
const GH_BOARD = "https://boards.greenhouse.io/stripedemo";
const GH_UNKNOWN_CLOSED = "https://boards.greenhouse.io/stripedemo/jobs/4099999";
const LEVER_IOS = "https://jobs.lever.co/netflixdemo/lever-ios-1";
const LEVER_UNKNOWN_CLOSED = "https://jobs.lever.co/netflixdemo/closed-role";

function html(file: string): string {
  return readFileSync(join(FIXTURES, file), "utf8");
}

function adaptersFor(fetchPage: FetchPage): BoardAdapter[] {
  return [
    createGreenhouseAdapter(fetchPage),
    createAshbyAdapter(fetchPage),
    createLeverAdapter(fetchPage),
  ];
}

function boardHtml(jobs: Array<{ href: string; title: string; location: string }>): string {
  const openings = jobs
    .map(
      (job) =>
        `<div class="opening"><a href="${job.href}">${job.title}</a><span class="location">${job.location}</span></div>`,
    )
    .join("");
  return `<!DOCTYPE html><html><head><title>Jobs at StripeDemo</title></head><body><h1>StripeDemo</h1>${openings}</body></html>`;
}

test("known job URL that 404s is 200 closed:true with empty description, not a live ghost", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  let stripeStatus = 200;
  const fetchPage: FetchPage = async (url) => {
    if (url.includes("/jobs/4000001")) {
      return {
        url: GH_STRIPE,
        status: stripeStatus,
        body: stripeStatus === 200 ? html("greenhouse/stripe-staff-engineer.html") : "",
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapters = adaptersFor(fetchPage);
  const t0 = new Date("2026-03-01T00:00:00.000Z");
  const t1 = new Date(t0.getTime() + OPEN_JOB_CACHE_MS + 1);

  const open = await getJobByUrl(GH_STRIPE, { adapters, db, now: t0 });
  assert.equal(open.closed, false);
  assert.equal(open.closedAt, null);
  assert.match(open.descriptionMarkdown, /Build payments APIs/);

  stripeStatus = 404;
  const closed = await getJobByUrl(GH_STRIPE, { adapters, db, now: t1 });
  assert.equal(closed.closed, true);
  assert.ok(closed.closedAt !== null);
  assert.match(closed.closedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(closed.descriptionMarkdown, "");
  assert.equal(closed.title, "Staff Software Engineer");
  assert.equal(closed.id, open.id);

  const stored = findStoredJob(db, GH_STRIPE);
  assert.equal(stored?.job.closed, true);
  assert.equal(stored?.job.descriptionMarkdown, "");
  assert.equal(stored?.hasFullDescription, false);
});

test("unknown job URL that 404s is job_closed, not a fabricated open record", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const fetchPage: FetchPage = async (url) => {
    if (url.includes("4099999")) {
      return { url: GH_UNKNOWN_CLOSED, status: 404, body: "" };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await assert.rejects(() => getJobByUrl(GH_UNKNOWN_CLOSED, { adapters: adaptersFor(fetchPage), db }), {
    name: "HireError",
    code: "job_closed",
  });
  assert.equal(findStoredJob(db, GH_UNKNOWN_CLOSED), null);
});

test("board omit marks the missing job closed and by-url does not serve the old description", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const both = boardHtml([
    { href: "/stripedemo/jobs/4000001", title: "Staff Software Engineer", location: "San Francisco, CA" },
    { href: "/stripedemo/jobs/4000011", title: "Payments Analyst", location: "Remote" },
  ]);
  const onlyStaff = boardHtml([
    { href: "/stripedemo/jobs/4000001", title: "Staff Software Engineer", location: "San Francisco, CA" },
  ]);
  let boardBody = both;
  let analystStatus = 200;
  const fetchPage: FetchPage = async (url) => {
    if (url === GH_BOARD || url === `${GH_BOARD}/`) {
      return { url: GH_BOARD, status: 200, body: boardBody };
    }
    if (url.includes("/jobs/4000001")) {
      return { url: GH_STRIPE, status: 200, body: html("greenhouse/stripe-staff-engineer.html") };
    }
    if (url.includes("/jobs/4000011")) {
      return {
        url: GH_ANALYST,
        status: analystStatus,
        body:
          analystStatus === 200
            ? `<!DOCTYPE html><html><body><h1 class="app-title">Payments Analyst</h1><span class="company-name">StripeDemo</span><div class="location">Remote</div><div id="content"><p>Old analyst description that must not leak after close.</p></div></body></html>`
            : "",
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapters = adaptersFor(fetchPage);

  const first = await getBoardByUrl(GH_BOARD, db, { adapters });
  assert.equal(first.jobs.length, 2);
  assert.equal(
    first.jobs.every((row) => row.hasFullDescription === false),
    true,
  );

  const ingested = await getJobByUrl(GH_ANALYST, { adapters, db });
  assert.equal(ingested.closed, false);
  assert.match(ingested.descriptionMarkdown, /Old analyst description/);

  boardBody = onlyStaff;
  analystStatus = 404;
  const second = await getBoardByUrl(GH_BOARD, db, { adapters });
  assert.equal(second.jobs.length, 1);
  assert.equal(second.jobs[0]?.title, "Staff Software Engineer");

  const closed = await getJobByUrl(GH_ANALYST, { adapters, db });
  assert.equal(closed.closed, true);
  assert.ok(closed.closedAt !== null);
  assert.equal(closed.descriptionMarkdown, "");
  assert.equal(closed.descriptionMarkdown.includes("Old analyst description"), false);
  assert.equal(closed.title, "Payments Analyst");
});

test("repeat by-url on an already-closed known job stays 200 closed without resurrecting Markdown", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  let status = 200;
  const fetchPage: FetchPage = async () => ({
    url: GH_STRIPE,
    status,
    body: status === 200 ? html("greenhouse/stripe-staff-engineer.html") : "",
  });
  const adapters = adaptersFor(fetchPage);
  const t0 = new Date("2026-03-01T00:00:00.000Z");
  const t1 = new Date(t0.getTime() + OPEN_JOB_CACHE_MS + 1);
  await getJobByUrl(GH_STRIPE, { adapters, db, now: t0 });
  status = 404;
  const first = await getJobByUrl(GH_STRIPE, { adapters, db, now: t1 });
  const second = await getJobByUrl(GH_STRIPE, { adapters, db, now: t1 });
  assert.equal(first.closed, true);
  assert.equal(second.closed, true);
  assert.equal(second.descriptionMarkdown, "");
  assert.equal(second.closedAt, first.closedAt);
});

test("GET /v1/jobs/by-url known 404 is 200 closed:true, empty Markdown, not 404", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const known = GH_UNKNOWN_CLOSED;
  upsertJobSummary(
    db,
    {
      id: "job_greenhouse_4099999",
      title: "Retired Role",
      company: { name: "StripeDemo", id: null },
      locations: [],
      remote: null,
      applyUrl: known,
      closed: false,
      hasFullDescription: false,
    },
    "greenhouse",
    "4099999",
    GH_BOARD,
    new Date("2026-03-01T00:00:00.000Z"),
  );
  const app = await buildApp({ db, bootstrapKey: "hk_test_closed_http" });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent(known)}`,
    headers: { authorization: "Bearer hk_test_closed_http" },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: Job;
    meta: { creditsCharged: number };
    error?: { code: ErrorCode };
  };
  assert.equal(body.data.closed, true);
  assert.ok(body.data.closedAt !== null);
  assert.equal(body.data.descriptionMarkdown, "");
  assert.equal(body.data.title, "Retired Role");
  assert.equal(body.meta.creditsCharged, 1);
});

test("known Lever job URL that 404s is 200 closed:true with empty description", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  let status = 200;
  const fetchPage: FetchPage = async (url) => {
    if (url.includes("lever-ios-1")) {
      return {
        url: LEVER_IOS,
        status,
        body: status === 200 ? html("lever/netflix-ios-engineer.html") : "",
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapters = adaptersFor(fetchPage);
  const t0 = new Date("2026-03-01T00:00:00.000Z");
  const t1 = new Date(t0.getTime() + OPEN_JOB_CACHE_MS + 1);

  const open = await getJobByUrl(LEVER_IOS, { adapters, db, now: t0 });
  assert.equal(open.source, "lever");
  assert.equal(open.closed, false);
  assert.match(open.descriptionMarkdown, /Ship the iOS client/);

  status = 404;
  const closed = await getJobByUrl(LEVER_IOS, { adapters, db, now: t1 });
  assert.equal(closed.closed, true);
  assert.ok(closed.closedAt !== null);
  assert.equal(closed.descriptionMarkdown, "");
  assert.equal(closed.title, "iOS Engineer");
  assert.equal(closed.id, open.id);
});

test("unknown Lever job URL that 404s is job_closed", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const fetchPage: FetchPage = async (url) => {
    if (url.includes("closed-role")) {
      return { url: LEVER_UNKNOWN_CLOSED, status: 404, body: "" };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await assert.rejects(
    () => getJobByUrl(LEVER_UNKNOWN_CLOSED, { adapters: adaptersFor(fetchPage), db }),
    { name: "HireError", code: "job_closed" },
  );
  assert.equal(findStoredJob(db, LEVER_UNKNOWN_CLOSED), null);
});

test("Job.closed true never includes a live open description", () => {
  const job: Job = {
    id: "job_greenhouse_1",
    source: "greenhouse",
    sourceJobId: "1",
    title: "Gone",
    company: { name: "Acme", id: null },
    locations: [],
    remote: null,
    employmentType: null,
    salary: null,
    descriptionMarkdown: "",
    applyUrl: GH_STRIPE,
    postedAt: null,
    closed: true,
    closedAt: "2026-01-02T00:00:00.000Z",
    fetchedAt: "2026-01-02T00:00:00.000Z",
  };
  assert.equal(job.closed, true);
  assert.equal(job.descriptionMarkdown, "");
});
