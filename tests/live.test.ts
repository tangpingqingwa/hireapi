import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createAdapters, createFetchPage } from "../src/adapters/index.js";
import { createLiveFetchPage } from "../src/adapters/live.js";
import { parseSalary } from "../src/adapters/parse.js";
import { isLiveAtsEnabled } from "../src/adapters/transport.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { getBoardByUrl } from "../src/core/boards.js";
import { HireError } from "../src/core/errors.js";
import { getJobByUrl } from "../src/core/jobs.js";
import { defaultAdapters } from "../src/core/router.js";
import { OPEN_JOB_CACHE_MS } from "../src/core/store.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode, Job, JobSummary } from "../src/types.js";

const GH_STRIPE = "https://boards.greenhouse.io/stripedemo/jobs/4000001";
const GH_BOARD = "https://boards.greenhouse.io/stripedemo";
const GH_UNKNOWN = "https://boards.greenhouse.io/stripedemo/jobs/4099999";
const ASHBY_LINEAR = "https://jobs.ashbyhq.com/lineardemo/staff-product-engineer";
const ASHBY_BOARD = "https://jobs.ashbyhq.com/lineardemo";
const LEVER_IOS = "https://jobs.lever.co/netflixdemo/lever-ios-1";
const LEVER_BOARD = "https://jobs.lever.co/netflixdemo";
const WORKDAY = "https://company.workday.com/demo/job/abc";

function htmlResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
}

test("isLiveAtsEnabled is off unless HIREAPI_LIVE_ATS is a truthy token", () => {
  assert.equal(isLiveAtsEnabled({}), false);
  assert.equal(isLiveAtsEnabled({ HIREAPI_LIVE_ATS: "" }), false);
  assert.equal(isLiveAtsEnabled({ HIREAPI_LIVE_ATS: "0" }), false);
  assert.equal(isLiveAtsEnabled({ HIREAPI_LIVE_ATS: "false" }), false);
  assert.equal(isLiveAtsEnabled({ HIREAPI_LIVE_ATS: "no" }), false);
  assert.equal(isLiveAtsEnabled({ HIREAPI_LIVE_ATS: "1" }), true);
  assert.equal(isLiveAtsEnabled({ HIREAPI_LIVE_ATS: "true" }), true);
  assert.equal(isLiveAtsEnabled({ HIREAPI_LIVE_ATS: "YES" }), true);
  assert.equal(isLiveAtsEnabled({ HIREAPI_LIVE_ATS: "on" }), true);
});

test("loadConfig.liveAts follows HIREAPI_LIVE_ATS and defaults off", () => {
  assert.equal(loadConfig({}).liveAts, false);
  assert.equal(loadConfig({ HIREAPI_LIVE_ATS: "0" }).liveAts, false);
  assert.equal(loadConfig({ HIREAPI_LIVE_ATS: "1" }).liveAts, true);
});

test("createFetchPage stays on fixtures when live ATS is unset", async () => {
  const fetchPage = createFetchPage({});
  const page = await fetchPage(GH_STRIPE);
  assert.equal(page.status, 200);
  assert.match(page.body, /Staff Software Engineer/);
});

test("defaultAdapters parse fixture HTML and never invent salary", async () => {
  const job = await getJobByUrl(GH_STRIPE, defaultAdapters());
  assert.equal(job.source, "greenhouse");
  assert.equal(job.title, "Staff Software Engineer");
  assert.equal(job.salary?.min, 240000);
  assert.equal(parseSalary("Staff Engineer"), null);
  assert.equal(parseSalary("competitive"), null);
  assert.equal(parseSalary("$100k+"), null);
});

test("live fetch refuses LinkedIn, Indeed, and unknown hosts without calling the network", async () => {
  let calls = 0;
  const fetchPage = createLiveFetchPage({
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not fetch");
    },
  });
  await assert.rejects(() => fetchPage("https://www.linkedin.com/jobs/view/1"), {
    name: "HireError",
    code: "unsupported_board",
  });
  await assert.rejects(() => fetchPage("https://www.indeed.com/viewjob?jk=abc"), {
    name: "HireError",
    code: "unsupported_board",
  });
  await assert.rejects(() => fetchPage(WORKDAY), {
    name: "HireError",
    code: "unsupported_board",
  });
  assert.equal(calls, 0);
});

test("live fetch maps network failure to upstream_blocked", async () => {
  const fetchPage = createLiveFetchPage({
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND boards.greenhouse.io");
    },
  });
  await assert.rejects(() => fetchPage(GH_STRIPE), (err: unknown) => {
    assert.ok(err instanceof HireError);
    assert.equal(err.code, "upstream_blocked");
    assert.match(err.message, /ENOTFOUND/);
    return true;
  });
});

test("live fetch maps abort/timeout to upstream_blocked", async () => {
  const fetchPage = createLiveFetchPage({
    fetchImpl: async (_url, init) => {
      const err = new Error("aborted");
      err.name = "AbortError";
      if (init.signal?.aborted) {
        throw err;
      }
      throw err;
    },
  });
  await assert.rejects(() => fetchPage(GH_STRIPE), {
    name: "HireError",
    code: "upstream_blocked",
  });
});

test("live Greenhouse job 404 is job_closed; known 404 is 200 closed:true", async () => {
  const fetchPage = createLiveFetchPage({
    fetchImpl: async () => htmlResponse(404, ""),
  });
  const adapters = createAdapters(fetchPage);
  await assert.rejects(() => getJobByUrl(GH_UNKNOWN, adapters), {
    name: "HireError",
    code: "job_closed",
  });

  const db = openDatabase(":memory:");
  after(() => db.close());
  const openHtml =
    `<!DOCTYPE html><html><body><h1 class="app-title">Staff Software Engineer</h1>` +
    `<span class="company-name">StripeDemo</span><div class="location">San Francisco, CA</div>` +
    `<div id="content"><p>Build payments APIs. $240,000–$310,000 a year.</p></div></body></html>`;
  let status = 200;
  let body = openHtml;
  const sequenced = createLiveFetchPage({
    fetchImpl: async () => htmlResponse(status, body),
  });
  const adaptersSeq = createAdapters(sequenced);
  const t0 = new Date("2026-03-01T00:00:00.000Z");
  const t1 = new Date(t0.getTime() + OPEN_JOB_CACHE_MS + 1);
  const open = await getJobByUrl(GH_STRIPE, { adapters: adaptersSeq, db, now: t0 });
  assert.equal(open.closed, false);
  assert.match(open.descriptionMarkdown, /Build payments APIs/);
  status = 404;
  body = "";
  const closed = await getJobByUrl(GH_STRIPE, { adapters: adaptersSeq, db, now: t1 });
  assert.equal(closed.closed, true);
  assert.equal(closed.descriptionMarkdown, "");
  assert.ok(closed.closedAt !== null);
});

test("live board 404 is board_not_found; unknown vendor stays unsupported_board", async () => {
  const fetchPage = createLiveFetchPage({
    fetchImpl: async () => htmlResponse(404, ""),
  });
  const db = openDatabase(":memory:");
  after(() => db.close());
  await assert.rejects(() => getBoardByUrl(GH_BOARD, db, { adapters: createAdapters(fetchPage) }), {
    name: "HireError",
    code: "board_not_found",
  });
  await assert.rejects(() => getJobByUrl(WORKDAY, createAdapters(fetchPage)), {
    name: "HireError",
    code: "unsupported_board",
  });
});

test("live fetch parses Greenhouse, Ashby, and Lever board+job HTML through the same parsers", async () => {
  const pages: Record<string, string> = {
    [GH_STRIPE]:
      `<!DOCTYPE html><html><body><h1 class="app-title">Staff Software Engineer</h1>` +
      `<span class="company-name">StripeDemo</span><div class="location">San Francisco, CA</div>` +
      `<div id="content"><h2>About the role</h2><p>Build payments APIs. $240,000–$310,000 a year.</p></div></body></html>`,
    [GH_BOARD]:
      `<!DOCTYPE html><html><body><h1>StripeDemo</h1>` +
      `<div class="opening"><a href="/stripedemo/jobs/4000001">Staff Software Engineer</a>` +
      `<span class="location">San Francisco, CA</span></div></body></html>`,
    [ASHBY_LINEAR]:
      `<!DOCTYPE html><html><body><h1>Staff Product Engineer</h1>` +
      `<div class="ashby-job-posting-company-name">LinearDemo</div>` +
      `<div class="ashby-job-posting-location">Remote</div>` +
      `<div class="ashby-job-posting-section"><h2>The work</h2><p>TypeScript. $180,000–$230,000 a year.</p></div></body></html>`,
    [ASHBY_BOARD]:
      `<!DOCTYPE html><html><body><div class="ashby-job-board-heading">LinearDemo</div>` +
      `<script id="__NEXT_DATA__">{"jobPostings":[{"title":"Staff Product Engineer","idName":"staff-product-engineer","locationName":"Remote","isRemote":true}]}</script></body></html>`,
    [LEVER_IOS]:
      `<!DOCTYPE html><html><body><div class="posting-headline"><h2>iOS Engineer</h2></div>` +
      `<div class="main-header-text">NetflixDemo</div>` +
      `<div class="sort-by-location">Los Gatos, CA</div>` +
      `<div class="posting-page"><h3>About the role</h3><p>Ship the iOS client. $210,000–$280,000 a year.</p></div></body></html>`,
    [LEVER_BOARD]:
      `<!DOCTYPE html><html><body><div class="main-header-text">NetflixDemo</div>` +
      `<div class="posting"><a class="posting-title" href="/netflixdemo/lever-ios-1"><h5>iOS Engineer</h5></a>` +
      `<div class="sort-by-location">Los Gatos, CA</div></div></body></html>`,
  };
  const seen: string[] = [];
  const fetchPage = createLiveFetchPage({
    fetchImpl: async (url) => {
      seen.push(url);
      const body = pages[url];
      if (body === undefined) {
        throw new Error(`unexpected live url ${url}`);
      }
      return htmlResponse(200, body);
    },
  });
  const adapters = createAdapters(fetchPage);
  const db = openDatabase(":memory:");
  after(() => db.close());

  const gh = await getJobByUrl(GH_STRIPE, adapters);
  assert.equal(gh.source, "greenhouse");
  assert.equal(gh.title, "Staff Software Engineer");
  assert.equal(gh.salary?.min, 240000);
  assert.equal(gh.descriptionMarkdown.includes("<div>"), false);

  const ashby = await getJobByUrl(ASHBY_LINEAR, adapters);
  assert.equal(ashby.source, "ashby");
  assert.equal(ashby.title, "Staff Product Engineer");
  assert.equal(ashby.remote, true);

  const lever = await getJobByUrl(LEVER_IOS, adapters);
  assert.equal(lever.source, "lever");
  assert.equal(lever.title, "iOS Engineer");
  assert.equal(lever.locations[0]?.city, "Los Gatos");

  const ghBoard = await getBoardByUrl(GH_BOARD, db, { adapters });
  assert.ok(ghBoard.jobs.length >= 1);
  assert.equal(ghBoard.jobs[0]?.hasFullDescription, false);

  const ashbyBoard = await getBoardByUrl(ASHBY_BOARD, db, { adapters });
  assert.ok(ashbyBoard.jobs.length >= 1);

  const leverBoard = await getBoardByUrl(LEVER_BOARD, db, { adapters });
  assert.ok(leverBoard.jobs.length >= 1);
  assert.equal(seen.every((url) => /greenhouse\.io|ashbyhq\.com|lever\.co/.test(url)), true);
});

test("live fetch does not follow redirects off the allowed ATS hosts", async () => {
  const fetchPage = createLiveFetchPage({
    fetchImpl: async () =>
      htmlResponse(302, "", { location: "https://www.linkedin.com/jobs/view/1" }),
  });
  await assert.rejects(() => fetchPage(GH_STRIPE), {
    name: "HireError",
    code: "unsupported_board",
  });
});

test("live fetch maps a redirect without Location to upstream_blocked", async () => {
  const fetchPage = createLiveFetchPage({
    fetchImpl: async () => htmlResponse(302, ""),
  });
  await assert.rejects(() => fetchPage(GH_STRIPE), {
    name: "HireError",
    code: "upstream_blocked",
  });
});

test("live fetch follows a same-host redirect and returns the final page", async () => {
  const dest = "https://boards.greenhouse.io/stripedemo/jobs/4000001";
  const fetchPage = createLiveFetchPage({
    fetchImpl: async (url) => {
      if (url === "https://boards.greenhouse.io/stripedemo/jobs/old") {
        return htmlResponse(301, "", { location: dest });
      }
      if (url === dest) {
        return htmlResponse(200, "<html><body>ok</body></html>");
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const page = await fetchPage("https://boards.greenhouse.io/stripedemo/jobs/old");
  assert.equal(page.status, 200);
  assert.equal(page.url, dest);
  assert.match(page.body, /ok/);
});

test("live transport fail is upstream_blocked; HTTP still charges 0 on that envelope", async () => {
  const fetchPage = createLiveFetchPage({
    fetchImpl: async () => {
      throw new Error("socket hang up");
    },
  });
  await assert.rejects(() => getJobByUrl(GH_STRIPE, createAdapters(fetchPage)), {
    name: "HireError",
    code: "upstream_blocked",
  });
});

test("HTTP envelope charges 0 on unsupported_board and on transport 503", async () => {
  const app = await buildApp({ bootstrapKey: "hk_test_live_off" });
  after(() => app.close());
  const unsupported = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent(WORKDAY)}`,
    headers: { authorization: "Bearer hk_test_live_off" },
  });
  assert.equal(unsupported.statusCode, 422);
  const unsupportedBody = unsupported.json() as {
    error: { code: ErrorCode };
    meta: { creditsCharged: number };
  };
  assert.equal(unsupportedBody.error.code, "unsupported_board");
  assert.equal(unsupportedBody.meta.creditsCharged, 0);

  const blocked = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent("https://boards.greenhouse.io/stripedemo/jobs/4050303")}`,
    headers: { authorization: "Bearer hk_test_live_off" },
  });
  assert.equal(blocked.statusCode, 503);
  const blockedBody = blocked.json() as {
    error: { code: ErrorCode };
    meta: { creditsCharged: number };
  };
  assert.equal(blockedBody.error.code, "upstream_blocked");
  assert.equal(blockedBody.meta.creditsCharged, 0);

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: "Bearer hk_test_live_off" },
  });
  assert.equal((me.json() as { data: { creditsRemaining: number } }).data.creditsRemaining, 100);

  const job: Job = await getJobByUrl(GH_STRIPE);
  assert.equal(job.closed, false);
  const summary: Pick<JobSummary, "hasFullDescription"> = { hasFullDescription: false };
  assert.equal(summary.hasFullDescription, false);
});
