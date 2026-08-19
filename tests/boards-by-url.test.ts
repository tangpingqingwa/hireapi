import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fixtureBoardUrls } from "../src/adapters/fixtures.js";
import { buildApp } from "../src/app.js";
import { createKey } from "../src/billing/keys.js";
import { getBoardByUrl } from "../src/core/boards.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode, JobSummary } from "../src/types.js";

const TEST_KEY = "hk_test_boards_by_url";
const GH_BOARD = "https://boards.greenhouse.io/stripedemo";
const ASHBY_BOARD = "https://jobs.ashbyhq.com/lineardemo";
const LEVER_BOARD = "https://jobs.lever.co/netflixdemo";
const EMPTY_BOARD = "https://boards.greenhouse.io/emptydemo";
const GONE_BOARD = "https://boards.greenhouse.io/gonedemo";

function assertSummary(row: JobSummary): void {
  assert.match(row.id, /^job_/);
  assert.ok(row.title.length > 0);
  assert.ok(row.company.name.length > 0);
  assert.ok(row.applyUrl.startsWith("http"));
  assert.equal(row.hasFullDescription, false);
  assert.equal(row.closed, false);
  assert.equal("descriptionMarkdown" in row, false);
}

test("fixture catalog includes Greenhouse, Ashby, and Lever board snapshots", () => {
  assert.ok(fixtureBoardUrls("greenhouse").length >= 1);
  assert.ok(fixtureBoardUrls("ashby").length >= 1);
  assert.ok(fixtureBoardUrls("lever").length >= 1);
});

test("getBoardByUrl Greenhouse fixture returns summary jobs only", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const board = await getBoardByUrl(GH_BOARD, db);
  assert.ok(board.jobs.length >= 1);
  for (const row of board.jobs) {
    assertSummary(row);
  }
  const staff = board.jobs.find((row) => row.title === "Staff Software Engineer");
  assert.ok(staff);
  assert.equal(staff.locations[0]?.city, "San Francisco");
  assert.equal(board.nextCursor, null);
});

test("getBoardByUrl Ashby fixture returns summary jobs only", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const board = await getBoardByUrl(ASHBY_BOARD, db);
  assert.ok(board.jobs.length >= 1);
  for (const row of board.jobs) {
    assertSummary(row);
  }
  assert.equal(board.jobs[0]?.title, "Staff Product Engineer");
  assert.equal(board.jobs[0]?.remote, true);
});

test("getBoardByUrl Lever fixture returns ≥1 summary job", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const board = await getBoardByUrl(LEVER_BOARD, db);
  assert.ok(board.jobs.length >= 1);
  for (const row of board.jobs) {
    assertSummary(row);
  }
  const ios = board.jobs.find((row) => row.title === "iOS Engineer");
  assert.ok(ios);
  assert.equal(ios.locations[0]?.city, "Los Gatos");
  assert.equal(ios.applyUrl, "https://jobs.lever.co/netflixdemo/lever-ios-1");
});

test("GET /v1/boards/by-url Greenhouse → 200 summaries, 1 credit per open job", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/boards/by-url?url=${encodeURIComponent(GH_BOARD)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: JobSummary[];
    meta: { creditsCharged: number; cached: boolean; requestId: string };
  };
  assert.ok(body.data.length >= 1);
  assert.equal(body.meta.creditsCharged, body.data.length);
  for (const row of body.data) {
    assertSummary(row);
  }
  assert.match(body.meta.requestId, /^req_/);
});

test("GET /v1/boards/by-url Lever → 200 summaries, 1 credit per open job", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/boards/by-url?url=${encodeURIComponent(LEVER_BOARD)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: JobSummary[]; meta: { creditsCharged: number } };
  assert.ok(body.data.length >= 1);
  assert.equal(body.meta.creditsCharged, body.data.length);
  assert.equal(body.data[0]?.hasFullDescription, false);
});

test("GET /v1/boards/by-url Ashby → 200 summaries, 1 credit per open job", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/boards/by-url?url=${encodeURIComponent(ASHBY_BOARD)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: JobSummary[]; meta: { creditsCharged: number } };
  assert.ok(body.data.length >= 1);
  assert.equal(body.meta.creditsCharged, body.data.length);
  assert.equal(body.data[0]?.hasFullDescription, false);
});

test("empty open board is 200 data:[] and 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/boards/by-url?url=${encodeURIComponent(EMPTY_BOARD)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: JobSummary[]; meta: { creditsCharged: number } };
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
    url: `/v1/boards/by-url?url=${encodeURIComponent("https://company.workday.com/demo")}`,
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
    url: `/v1/boards/by-url?url=${encodeURIComponent(GONE_BOARD)}`,
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

test("GET /v1/boards/by-url LinkedIn is 422 source_disabled, 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/boards/by-url?url=${encodeURIComponent("https://www.linkedin.com/jobs/company/1")}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 422);
  assert.equal((response.json() as { error: { code: string } }).error.code, "source_disabled");
  assert.equal((response.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});

test("GET /v1/boards/by-url without bearer is 401 with 0 credits", async () => {
  const app = await buildApp();
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/boards/by-url?url=${encodeURIComponent(GH_BOARD)}`,
  });
  assert.equal(response.statusCode, 401);
  assert.equal((response.json() as { error: { code: string } }).error.code, "unauthorized");
  assert.equal((response.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});

test("zero-credit key cannot list a non-empty board", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, { secret: "hk_test_broke_board", credits: 0 });
  const app = await buildApp({ db });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/boards/by-url?url=${encodeURIComponent(GH_BOARD)}`,
    headers: { authorization: "Bearer hk_test_broke_board" },
  });
  assert.equal(response.statusCode, 402);
  assert.equal((response.json() as { error: { code: string } }).error.code, "payment_required");
  assert.equal((response.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});

test("GET /v1/jobs/by-url unknown 404 fixture is 404 job_closed, 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent("https://boards.greenhouse.io/stripedemo/jobs/4099999")}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 404);
  const body = response.json() as {
    error: { code: ErrorCode };
    meta: { creditsCharged: number };
  };
  assert.equal(body.error.code, "job_closed");
  assert.equal(body.meta.creditsCharged, 0);
});

test("cursor query is accepted and unused when the board fits one page", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/boards/by-url?url=${encodeURIComponent(GH_BOARD)}&cursor=unused`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: JobSummary[] };
  assert.ok(body.data.length >= 1);
});
