import assert from "node:assert/strict";
import { after, test } from "node:test";
import { matchAshbyBoardUrl, matchAshbyJobUrl } from "../src/adapters/ashby.js";
import { fixtureJobUrls } from "../src/adapters/fixtures.js";
import {
  matchGreenhouseBoardUrl,
  matchGreenhouseJobUrl,
} from "../src/adapters/greenhouse.js";
import { matchLeverBoardUrl, matchLeverJobUrl } from "../src/adapters/lever.js";
import { parseSalary } from "../src/adapters/parse.js";
import { buildApp } from "../src/app.js";
import { createKey } from "../src/billing/keys.js";
import { getJobByUrl } from "../src/core/jobs.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode, Job } from "../src/types.js";

const TEST_KEY = "hk_test_jobs_by_url";

const GH_STRIPE = "https://boards.greenhouse.io/stripedemo/jobs/4000001";
const GH_NOTION = "https://boards.greenhouse.io/notiondemo/jobs/4000002";
const GH_AIRBNB = "https://boards.greenhouse.io/airbnbdemo/jobs/4000003";
const GH_DISCORD = "https://boards.greenhouse.io/discorddemo/jobs/4000004";
const GH_FIGMA = "https://job-boards.greenhouse.io/figmademo/jobs/4000005";
const GH_COINBASE = "https://boards.greenhouse.io/coinbasedemo/jobs/4000006";
const GH_CLOUDFLARE = "https://boards.greenhouse.io/cloudflaredemo/jobs/4000007";
const GH_DATADOG = "https://boards.greenhouse.io/embed/job_app?for=datadogdemo&token=4000008";
const ASHBY_LINEAR = "https://jobs.ashbyhq.com/lineardemo/staff-product-engineer";
const ASHBY_RAMP = "https://jobs.ashbyhq.com/rampdemo/backend-engineer";
const ASHBY_VERCEL = "https://jobs.ashbyhq.com/verceldemo/solutions-engineer";
const ASHBY_OPENAI = "https://jobs.ashbyhq.com/openaidemo/research-engineer";
const ASHBY_ANTHROPIC = "https://jobs.ashbyhq.com/anthropicdemo/safety-engineer";
const ASHBY_RETOOL = "https://jobs.ashbyhq.com/retooldemo/forward-deployed-engineer";
const ASHBY_MERCURY = "https://jobs.ashbyhq.com/mercurydemo/support-specialist";
const LEVER_NETFLIX = "https://jobs.lever.co/netflixdemo/lever-ios-1";
const LEVER_SHOPIFY = "https://jobs.lever.co/shopifydemo/lever-backend-1";
const LEVER_TWITCH = "https://jobs.lever.co/twitchdemo/lever-sre-1";
const LEVER_DUOLINGO = "https://jobs.lever.co/duolingodemo/lever-intern-1";
const LEVER_BOX = "https://jobs.lever.co/boxdemo/lever-part-time-1";

function assertJobShape(job: Job): void {
  assert.match(job.id, /^job_/);
  assert.ok(job.title.length > 0);
  assert.ok(job.company.name.length > 0);
  assert.equal(job.company.id, null);
  assert.ok(Array.isArray(job.locations));
  assert.ok(job.applyUrl.startsWith("http"));
  assert.equal(typeof job.descriptionMarkdown, "string");
  assert.equal(job.descriptionMarkdown.includes("<div>"), false);
  assert.equal(job.descriptionMarkdown.includes("<script"), false);
  assert.equal(job.closed, false);
  assert.equal(job.closedAt, null);
  assert.match(job.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
}

test("matchJobUrl accepts Greenhouse, Ashby, and Lever job URLs only", () => {
  assert.equal(matchGreenhouseJobUrl(GH_STRIPE), true);
  assert.equal(matchGreenhouseJobUrl(GH_FIGMA), true);
  assert.equal(matchGreenhouseJobUrl(GH_DATADOG), true);
  assert.equal(matchGreenhouseJobUrl("https://boards.greenhouse.io/stripedemo"), false);
  assert.equal(matchGreenhouseBoardUrl("https://boards.greenhouse.io/stripedemo"), true);
  assert.equal(matchGreenhouseBoardUrl(GH_STRIPE), false);

  assert.equal(matchAshbyJobUrl(ASHBY_LINEAR), true);
  assert.equal(matchAshbyJobUrl("https://jobs.ashbyhq.com/lineardemo"), false);
  assert.equal(matchAshbyBoardUrl("https://jobs.ashbyhq.com/lineardemo"), true);
  assert.equal(matchAshbyBoardUrl(ASHBY_LINEAR), false);

  assert.equal(matchLeverJobUrl(LEVER_NETFLIX), true);
  assert.equal(matchLeverJobUrl("https://jobs.lever.co/netflixdemo"), false);
  assert.equal(matchLeverBoardUrl("https://jobs.lever.co/netflixdemo"), true);
  assert.equal(matchLeverBoardUrl(LEVER_NETFLIX), false);
  assert.equal(matchLeverJobUrl("https://jobs.lever.co/netflixdemo/lever-ios-1/apply"), true);

  assert.equal(matchGreenhouseJobUrl(ASHBY_LINEAR), false);
  assert.equal(matchAshbyJobUrl(GH_STRIPE), false);
  assert.equal(matchGreenhouseJobUrl(LEVER_NETFLIX), false);
  assert.equal(matchAshbyJobUrl(LEVER_NETFLIX), false);
  assert.equal(matchLeverJobUrl(GH_STRIPE), false);
  assert.equal(matchLeverJobUrl("https://www.lever.co/blog/something"), false);
  assert.equal(
    matchGreenhouseJobUrl("https://example.com/careers?q=greenhouse.io/embed/job_app&token=123"),
    false,
  );
  assert.equal(matchAshbyJobUrl("https://www.ashbyhq.com/blog/something"), false);
  assert.equal(matchAshbyJobUrl("https://ashbyhq.com/blog/something"), false);
});

test("parseSalary only accepts explicit ranges or singles with a period", () => {
  assert.deepEqual(parseSalary("$120,000–$140,000 a year"), {
    min: 120000,
    max: 140000,
    currency: "USD",
    period: "year",
    raw: "$120,000–$140,000 a year",
  });
  assert.deepEqual(parseSalary("$55 an hour"), {
    min: 55,
    max: 55,
    currency: "USD",
    period: "hour",
    raw: "$55 an hour",
  });
  assert.equal(parseSalary("competitive"), null);
  assert.equal(parseSalary("$100k+"), null);
  assert.equal(parseSalary("Staff Engineer"), null);
  assert.equal(parseSalary("DOE"), null);
  assert.deepEqual(parseSalary("Hourly contractors should not apply. This is $160,000 a year."), {
    min: 160000,
    max: 160000,
    currency: "USD",
    period: "year",
    raw: "$160,000 a year",
  });
});

test("fixture catalog is 8 Greenhouse + 7 Ashby + 5 Lever job snapshots", () => {
  const gh = fixtureJobUrls("greenhouse");
  const ashby = fixtureJobUrls("ashby");
  const lever = fixtureJobUrls("lever");
  assert.equal(gh.length, 8);
  assert.equal(ashby.length, 7);
  assert.equal(lever.length, 5);
});

test("getJobByUrl parses every Greenhouse fixture into the Job schema", async () => {
  const cases: Array<{ url: string; title: string; sourceJobId: string }> = [
    { url: GH_STRIPE, title: "Staff Software Engineer", sourceJobId: "4000001" },
    { url: GH_NOTION, title: "Product Manager", sourceJobId: "4000002" },
    { url: GH_AIRBNB, title: "Software Engineering Intern", sourceJobId: "4000003" },
    { url: GH_DISCORD, title: "Infrastructure Contractor", sourceJobId: "4000004" },
    { url: GH_FIGMA, title: "Community Programs Lead", sourceJobId: "4000005" },
    { url: GH_COINBASE, title: "Security Engineer", sourceJobId: "4000006" },
    { url: GH_CLOUDFLARE, title: "Edge Systems Engineer", sourceJobId: "4000007" },
    { url: GH_DATADOG, title: "Observability Engineer", sourceJobId: "4000008" },
  ];
  for (const item of cases) {
    const job = await getJobByUrl(item.url);
    assertJobShape(job);
    assert.equal(job.source, "greenhouse");
    assert.equal(job.title, item.title);
    assert.equal(job.sourceJobId, item.sourceJobId);
  }
});

test("getJobByUrl parses every Ashby fixture into the Job schema", async () => {
  const cases: Array<{ url: string; title: string; sourceJobId: string }> = [
    { url: ASHBY_LINEAR, title: "Staff Product Engineer", sourceJobId: "staff-product-engineer" },
    { url: ASHBY_RAMP, title: "Backend Engineer", sourceJobId: "backend-engineer" },
    { url: ASHBY_VERCEL, title: "Solutions Engineer", sourceJobId: "solutions-engineer" },
    { url: ASHBY_OPENAI, title: "Research Engineer", sourceJobId: "research-engineer" },
    { url: ASHBY_ANTHROPIC, title: "Safety Engineer", sourceJobId: "safety-engineer" },
    { url: ASHBY_RETOOL, title: "Forward Deployed Engineer", sourceJobId: "forward-deployed-engineer" },
    { url: ASHBY_MERCURY, title: "Support Specialist", sourceJobId: "support-specialist" },
  ];
  for (const item of cases) {
    const job = await getJobByUrl(item.url);
    assertJobShape(job);
    assert.equal(job.source, "ashby");
    assert.equal(job.title, item.title);
    assert.equal(job.sourceJobId, item.sourceJobId);
  }
});

test("Greenhouse job: salary, locations, Markdown, no leftover HTML", async () => {
  const job = await getJobByUrl(GH_STRIPE);
  assert.equal(job.company.name, "StripeDemo");
  assert.equal(job.employmentType, "full_time");
  assert.equal(job.remote, false);
  assert.equal(job.locations[0]?.city, "San Francisco");
  assert.equal(job.locations[0]?.region, "CA");
  assert.equal(job.salary?.min, 240000);
  assert.equal(job.salary?.max, 310000);
  assert.equal(job.salary?.currency, "USD");
  assert.equal(job.salary?.period, "year");
  assert.match(job.descriptionMarkdown, /^## About the role/m);
  assert.match(job.descriptionMarkdown, /^- Design TypeScript services/m);
  assert.match(job.descriptionMarkdown, /\[this posting\]/);
  assert.equal(/<[a-zA-Z]/.test(job.descriptionMarkdown), false);
});

test("Greenhouse remote + intern hourly + contract + ambiguous salary", async () => {
  const remote = await getJobByUrl(GH_NOTION);
  assert.equal(remote.remote, true);
  assert.equal(remote.salary, null);

  const intern = await getJobByUrl(GH_AIRBNB);
  assert.equal(intern.employmentType, "intern");
  assert.equal(intern.salary?.min, 55);
  assert.equal(intern.salary?.period, "hour");
  assert.equal(intern.remote, false);

  const contract = await getJobByUrl(GH_DISCORD);
  assert.equal(contract.employmentType, "contract");
  assert.equal(contract.salary, null);
  assert.equal(contract.descriptionMarkdown.includes("do-not-leak"), false);
  assert.equal(contract.descriptionMarkdown.includes(".secret"), false);

  const noRange = await getJobByUrl(GH_COINBASE);
  assert.equal(noRange.salary, null);
  assert.equal(noRange.remote, true);

  const london = await getJobByUrl(GH_CLOUDFLARE);
  assert.equal(london.salary?.currency, "GBP");
  assert.equal(london.salary?.min, 90000);
  assert.equal(london.locations[0]?.city, "London");
  assert.equal(london.remote, false);

  const part = await getJobByUrl(GH_FIGMA);
  assert.equal(part.employmentType, "part_time");
  assert.equal(part.salary?.period, "month");
  assert.equal(part.salary?.min, 4500);

  const embed = await getJobByUrl(GH_DATADOG);
  assert.equal(embed.sourceJobId, "4000008");
  assert.equal(embed.salary?.currency, "EUR");
  assert.match(embed.descriptionMarkdown, /wrapper that a naive regex would truncate/);
  assert.match(embed.descriptionMarkdown, /\[Read the handbook\]/);
});

test("getJobByUrl parses every Lever fixture into the Job schema", async () => {
  const cases: Array<{ url: string; title: string; sourceJobId: string }> = [
    { url: LEVER_NETFLIX, title: "iOS Engineer", sourceJobId: "lever-ios-1" },
    { url: LEVER_SHOPIFY, title: "Backend Engineer", sourceJobId: "lever-backend-1" },
    { url: LEVER_TWITCH, title: "Site Reliability Contractor", sourceJobId: "lever-sre-1" },
    { url: LEVER_DUOLINGO, title: "Software Engineering Intern", sourceJobId: "lever-intern-1" },
    { url: LEVER_BOX, title: "Community Programs Lead", sourceJobId: "lever-part-time-1" },
  ];
  for (const item of cases) {
    const job = await getJobByUrl(item.url);
    assertJobShape(job);
    assert.equal(job.source, "lever");
    assert.equal(job.title, item.title);
    assert.equal(job.sourceJobId, item.sourceJobId);
  }
});

test("Lever job: salary, locations, Markdown, no leftover HTML", async () => {
  const job = await getJobByUrl(LEVER_NETFLIX);
  assert.equal(job.company.name, "NetflixDemo");
  assert.equal(job.employmentType, "full_time");
  assert.equal(job.remote, false);
  assert.equal(job.locations[0]?.city, "Los Gatos");
  assert.equal(job.locations[0]?.region, "CA");
  assert.equal(job.salary?.min, 210000);
  assert.equal(job.salary?.max, 280000);
  assert.equal(job.salary?.currency, "USD");
  assert.equal(job.salary?.period, "year");
  assert.match(job.descriptionMarkdown, /^### About the role/m);
  assert.match(job.descriptionMarkdown, /^- Own Swift playback features/m);
  assert.match(job.descriptionMarkdown, /\[this posting\]/);
  assert.equal(/<[a-zA-Z]/.test(job.descriptionMarkdown), false);

  const remote = await getJobByUrl(LEVER_SHOPIFY);
  assert.equal(remote.remote, true);
  assert.equal(remote.salary?.min, 170000);
  assert.equal(remote.salary?.max, 220000);
  assert.equal(remote.locations[0]?.raw.includes("Canada"), true);

  const contract = await getJobByUrl(LEVER_TWITCH);
  assert.equal(contract.employmentType, "contract");
  assert.equal(contract.salary, null);
  assert.equal(contract.descriptionMarkdown.includes("do-not-leak"), false);
  assert.equal(contract.descriptionMarkdown.includes(".secret"), false);

  const intern = await getJobByUrl(LEVER_DUOLINGO);
  assert.equal(intern.employmentType, "intern");
  assert.equal(intern.salary?.min, 48);
  assert.equal(intern.salary?.period, "hour");
  assert.equal(intern.remote, false);

  const part = await getJobByUrl(LEVER_BOX);
  assert.equal(part.employmentType, "part_time");
  assert.equal(part.salary?.period, "month");
  assert.equal(part.salary?.min, 3800);
});

test("Ashby job: salary, remote, Markdown, no leftover HTML", async () => {
  const job = await getJobByUrl(ASHBY_LINEAR);
  assert.equal(job.company.name, "LinearDemo");
  assert.equal(job.remote, true);
  assert.equal(job.salary?.min, 180000);
  assert.equal(job.salary?.max, 230000);
  assert.match(job.descriptionMarkdown, /^## The work/m);
  assert.match(job.descriptionMarkdown, /^- TypeScript/m);
  assert.equal(/<[a-zA-Z]/.test(job.descriptionMarkdown), false);

  const ramp = await getJobByUrl(ASHBY_RAMP);
  assert.equal(ramp.locations[0]?.city, "New York");
  assert.equal(ramp.remote, false);

  const vercel = await getJobByUrl(ASHBY_VERCEL);
  assert.equal(vercel.salary, null);
  assert.equal(vercel.remote, true);

  const mercury = await getJobByUrl(ASHBY_MERCURY);
  assert.equal(mercury.employmentType, "part_time");
  assert.equal(mercury.salary?.period, "hour");
  assert.equal(mercury.salary?.min, 28);

  const retool = await getJobByUrl(ASHBY_RETOOL);
  assert.equal(retool.salary?.min, 160000);
  assert.equal(retool.salary?.max, 160000);
  assert.equal(retool.salary?.currency, "USD");
  assert.equal(retool.salary?.period, "year");
});

test("unknown vendor and disabled sources do not invent a job", async () => {
  await assert.rejects(() => getJobByUrl("https://company.workday.com/demo/job/abc"), {
    name: "HireError",
    code: "unsupported_board",
  });
  await assert.rejects(() => getJobByUrl("https://example.com/careers/1"), {
    name: "HireError",
    code: "unsupported_board",
  });
  await assert.rejects(() => getJobByUrl("https://www.linkedin.com/jobs/view/123"), {
    name: "HireError",
    code: "source_disabled",
  });
  await assert.rejects(() => getJobByUrl("https://www.indeed.com/viewjob?jk=abc"), {
    name: "HireError",
    code: "source_disabled",
  });
  await assert.rejects(() => getJobByUrl("not-a-url"), {
    name: "HireError",
    code: "invalid_request",
  });
});

test("GET /v1/jobs/by-url Greenhouse fixture → 200 Job, 1 credit, Markdown", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent(GH_STRIPE)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: Job;
    meta: { creditsCharged: number; cached: boolean; requestId: string; upstreamMs: number };
  };
  assert.equal(body.data.source, "greenhouse");
  assert.equal(body.data.title, "Staff Software Engineer");
  assert.equal(body.data.descriptionMarkdown.includes("<div>"), false);
  assert.equal(body.meta.creditsCharged, 1);
  assert.equal(body.meta.cached, false);
  assert.match(body.meta.requestId, /^req_/);
});

test("GET /v1/jobs/by-url Lever fixture → 200 Job, 1 credit, Markdown", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent(LEVER_NETFLIX)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: Job; meta: { creditsCharged: number } };
  assert.equal(body.data.source, "lever");
  assert.equal(body.data.title, "iOS Engineer");
  assert.equal(body.data.descriptionMarkdown.includes("<div>"), false);
  assert.equal(body.meta.creditsCharged, 1);
});

test("GET /v1/jobs/by-url Ashby fixture → 200 Job, 1 credit", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent(ASHBY_LINEAR)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: Job; meta: { creditsCharged: number } };
  assert.equal(body.data.source, "ashby");
  assert.equal(body.data.title, "Staff Product Engineer");
  assert.equal(body.meta.creditsCharged, 1);
});

test("GET /v1/jobs/by-url unknown vendor is 422 unsupported_board and 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent("https://company.workday.com/demo/job/abc")}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 422);
  const body = response.json() as {
    error: { code: ErrorCode };
    meta: { creditsCharged: number };
  };
  assert.equal(body.error.code, "unsupported_board");
  assert.equal(body.meta.creditsCharged, 0);

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal((me.json() as { data: { creditsRemaining: number } }).data.creditsRemaining, 100);
});

test("query-string Greenhouse and marketing Ashby hosts are 422 unsupported_board, 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const spoofed = [
    "https://example.com/careers?q=greenhouse.io/embed/job_app&token=123",
    "https://www.ashbyhq.com/blog/something",
  ];
  for (const url of spoofed) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/jobs/by-url?url=${encodeURIComponent(url)}`,
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    assert.equal(response.statusCode, 422);
    const body = response.json() as {
      error: { code: ErrorCode };
      meta: { creditsCharged: number };
    };
    assert.equal(body.error.code, "unsupported_board");
    assert.equal(body.meta.creditsCharged, 0);
  }

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal((me.json() as { data: { creditsRemaining: number } }).data.creditsRemaining, 100);
});

test("GET /v1/jobs/by-url without bearer is 401 with 0 credits", async () => {
  const app = await buildApp();
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent(GH_STRIPE)}`,
  });
  assert.equal(response.statusCode, 401);
  const body = response.json() as {
    error: { code: string };
    meta: { creditsCharged: number };
  };
  assert.equal(body.error.code, "unauthorized");
  assert.equal(body.meta.creditsCharged, 0);
});

test("GET /v1/jobs/by-url LinkedIn/Indeed is 422 source_disabled, 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent("https://www.linkedin.com/jobs/view/1")}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 422);
  assert.equal((response.json() as { error: { code: string } }).error.code, "source_disabled");
  assert.equal((response.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});

test("zero-credit key is 402 and does not parse as a success", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, { secret: "hk_test_broke", credits: 0 });
  const app = await buildApp({ db });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent(GH_STRIPE)}`,
    headers: { authorization: "Bearer hk_test_broke" },
  });
  assert.equal(response.statusCode, 402);
  assert.equal((response.json() as { error: { code: string } }).error.code, "payment_required");
  assert.equal((response.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});
