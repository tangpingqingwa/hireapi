import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { createKey } from "../src/billing/keys.js";
import { getBoardByUrl } from "../src/core/boards.js";
import { openDatabase } from "../src/db.js";
import { MCP_PATH, MCP_PROTOCOL_VERSION } from "../src/mcp/server.js";
import {
  GET_JOB_TOOL,
  LIST_BOARD_TOOL,
  MCP_SKILL,
  SEARCH_JOBS_TOOL,
} from "../src/mcp/tools.js";
import type { ErrorCode, Job, JobSummary } from "../src/types.js";

const KEY = "hk_test_mcp_fixture";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GH_STRIPE = "https://boards.greenhouse.io/stripedemo/jobs/4000001";
const GH_BOARD = "https://boards.greenhouse.io/stripedemo";
const GH_UNKNOWN_CLOSED = "https://boards.greenhouse.io/stripedemo/jobs/4099999";
const EMPTY_BOARD = "https://boards.greenhouse.io/emptydemo";
const GONE_BOARD = "https://boards.greenhouse.io/gonedemo";

type OkBody<T> = {
  data: T;
  meta: {
    cached: boolean;
    creditsCharged: number;
    requestId: string;
    upstreamMs: number;
  };
};

type ErrBody = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: number; requestId: string };
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: OkBody<unknown> | ErrBody;
  isError: boolean;
};

type JsonRpcOk = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
};

async function appWithKey(credits = 100) {
  const db = openDatabase(":memory:");
  createKey(db, { secret: KEY, credits });
  const app = await buildApp({ db });
  after(async () => {
    await app.close();
    db.close();
  });
  return { app, db };
}

function auth() {
  return { authorization: `Bearer ${KEY}` };
}

async function rpc(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: string,
  params?: unknown,
  headers: Record<string, string> = auth(),
) {
  return app.inject({
    method: "POST",
    url: MCP_PATH,
    headers,
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
}

async function callTool(
  app: Awaited<ReturnType<typeof buildApp>>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await rpc(app, "tools/call", { name, arguments: args });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as JsonRpcOk;
  const result = body.result as ToolResult;
  assert.ok(result);
  assert.equal(typeof result.isError, "boolean");
  return result;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      out.push(...walkTs(path));
    } else if (name.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

function remainingCredits(db: ReturnType<typeof openDatabase>): number {
  return (db.prepare("SELECT credits FROM keys").get() as { credits: number }).credits;
}

function assertSummary(row: JobSummary): void {
  assert.match(row.id, /^job_/);
  assert.ok(row.title.length > 0);
  assert.ok(row.company.name.length > 0);
  assert.ok(row.applyUrl.startsWith("http"));
  assert.equal(row.hasFullDescription, false);
  assert.equal(row.closed, false);
  assert.equal("descriptionMarkdown" in row, false);
}

test("GET /llms.txt is public and matches the checked-in file", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({ method: "GET", url: "/llms.txt" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/plain/);
  const onDisk = readFileSync(join(ROOT, "llms.txt"), "utf8");
  assert.equal(response.body, onDisk);
  assert.match(onDisk, /get_job/);
  assert.match(onDisk, /list_board/);
  assert.match(onDisk, /search_jobs/);
  assert.match(onDisk, /When not to call/i);
  assert.match(onDisk, /we do not apply/i);
  assert.match(onDisk, /salary may be null/i);
  assert.match(onDisk, /LinkedIn not available/i);
  assert.match(onDisk, /hk_live_/);
});

test("GET /.well-known/mcp/server-card.json lists shipped tools only", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: "/.well-known/mcp/server-card.json",
  });
  assert.equal(response.statusCode, 200);
  const card = response.json() as { tools: string[]; transport: string };
  assert.equal(card.transport, "streamable-http");
  assert.deepEqual(card.tools, [GET_JOB_TOOL, LIST_BOARD_TOOL, SEARCH_JOBS_TOOL]);
});

test("POST /mcp without bearer is 401 with 0 credits", async () => {
  const { app } = await appWithKey();
  const response = await rpc(app, "initialize", undefined, {});
  assert.equal(response.statusCode, 401);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "unauthorized");
  assert.equal(body.meta.creditsCharged, 0);
});

test("initialize and tools/list describe get_job, list_board, and search_jobs", async () => {
  const { app } = await appWithKey();

  const init = await rpc(app, "initialize");
  assert.equal(init.statusCode, 200);
  const initResult = (init.json() as JsonRpcOk).result as {
    protocolVersion: string;
    capabilities: { tools: unknown };
    serverInfo: { name: string };
    instructions: string;
  };
  assert.equal(initResult.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(initResult.serverInfo.name, "hireapi");
  assert.ok(initResult.capabilities.tools);
  assert.equal(initResult.instructions, MCP_SKILL);
  assert.match(initResult.instructions, /we do not apply/i);
  assert.match(initResult.instructions, /salary may be null/i);
  assert.match(initResult.instructions, /LinkedIn is not available/i);

  const listed = await rpc(app, "tools/list");
  assert.equal(listed.statusCode, 200);
  const tools = (
    (listed.json() as JsonRpcOk).result as {
      tools: Array<{ name: string; description: string }>;
    }
  ).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [GET_JOB_TOOL, LIST_BOARD_TOOL, SEARCH_JOBS_TOOL],
  );
  for (const tool of tools) {
    assert.match(tool.description, /we do not apply/i);
    assert.match(tool.description, /salary may be null|LinkedIn is not available/i);
  }
});

test("MCP get_job matches REST by-url and charges 1", async () => {
  const { app, db } = await appWithKey(10);

  const rest = await app.inject({
    method: "GET",
    url: `/v1/jobs/by-url?url=${encodeURIComponent(GH_STRIPE)}`,
    headers: auth(),
  });
  assert.equal(rest.statusCode, 200);
  const restBody = rest.json() as OkBody<Job>;
  assert.equal(restBody.data.title, "Staff Software Engineer");
  assert.equal(restBody.data.company.id, "co_greenhouse_stripedemo");
  assert.ok(restBody.data.salary !== null);
  assert.match(restBody.data.applyUrl, /boards\.greenhouse\.io/);
  assert.equal(restBody.data.descriptionMarkdown.includes("<div>"), false);
  assert.equal(restBody.meta.creditsCharged, 1);

  const mcp = await callTool(app, GET_JOB_TOOL, { url: GH_STRIPE });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<Job>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, 1);
  assert.equal(remainingCredits(db), 8);
});

test("MCP get_job salary may be null and applyUrl stays on the source", async () => {
  const { app } = await appWithKey();
  const notion = "https://boards.greenhouse.io/notiondemo/jobs/4000002";
  const mcp = await callTool(app, GET_JOB_TOOL, { url: notion });
  assert.equal(mcp.isError, false);
  const body = mcp.structuredContent as OkBody<Job>;
  assert.equal(body.data.salary, null);
  assert.match(body.data.applyUrl, /^https:\/\/boards\.greenhouse\.io\//);
  assert.equal(body.meta.creditsCharged, 1);
});

test("MCP list_board matches REST summaries and charges 1 per open job", async () => {
  const { app, db } = await appWithKey(20);

  const rest = await app.inject({
    method: "GET",
    url: `/v1/boards/by-url?url=${encodeURIComponent(GH_BOARD)}`,
    headers: auth(),
  });
  assert.equal(rest.statusCode, 200);
  const restBody = rest.json() as OkBody<JobSummary[]>;
  assert.ok(restBody.data.length >= 1);
  assert.equal(restBody.meta.creditsCharged, restBody.data.length);
  for (const row of restBody.data) {
    assertSummary(row);
  }

  const mcp = await callTool(app, LIST_BOARD_TOOL, { url: GH_BOARD });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<JobSummary[]>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, restBody.data.length);
  assert.equal(remainingCredits(db), 20 - restBody.data.length * 2);
});

test("MCP list_board empty open board is [] and 0 credits", async () => {
  const { app, db } = await appWithKey(5);
  const mcp = await callTool(app, LIST_BOARD_TOOL, { url: EMPTY_BOARD });
  assert.equal(mcp.isError, false);
  const body = mcp.structuredContent as OkBody<JobSummary[]>;
  assert.deepEqual(body.data, []);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(remainingCredits(db), 5);
});

test("MCP search_jobs hits an ingested title and charges 1 per hit", async () => {
  const { app, db } = await appWithKey(15);
  await getBoardByUrl(GH_BOARD, db);

  const rest = await app.inject({
    method: "GET",
    url: "/v1/search?q=Staff",
    headers: auth(),
  });
  assert.equal(rest.statusCode, 200);
  const restBody = rest.json() as OkBody<JobSummary[]>;
  assert.ok(restBody.data.length >= 1);
  assert.ok(restBody.data.some((row) => row.title === "Staff Software Engineer"));
  assert.equal(restBody.meta.creditsCharged, restBody.data.length);
  for (const row of restBody.data) {
    assertSummary(row);
  }

  const mcp = await callTool(app, SEARCH_JOBS_TOOL, { q: "Staff" });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<JobSummary[]>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, restBody.data.length);

  const empty = await callTool(app, SEARCH_JOBS_TOOL, { q: "zzzz-no-such-role" });
  assert.equal(empty.isError, false);
  const emptyBody = empty.structuredContent as OkBody<JobSummary[]>;
  assert.deepEqual(emptyBody.data, []);
  assert.equal(emptyBody.meta.creditsCharged, 0);
  assert.equal(remainingCredits(db), 15 - restBody.data.length * 2);
});

test("MCP LinkedIn/Indeed and unknown vendor charge 0", async () => {
  const { app, db } = await appWithKey(7);

  const indeed = await callTool(app, SEARCH_JOBS_TOOL, { source: "indeed" });
  assert.equal(indeed.isError, true);
  const indeedBody = indeed.structuredContent as ErrBody;
  assert.equal(indeedBody.error.code, "source_disabled");
  assert.equal(indeedBody.meta.creditsCharged, 0);

  const linkedin = await callTool(app, GET_JOB_TOOL, {
    url: "https://www.linkedin.com/jobs/view/123",
  });
  assert.equal(linkedin.isError, true);
  const linkedinBody = linkedin.structuredContent as ErrBody;
  assert.equal(linkedinBody.error.code, "source_disabled");
  assert.equal(linkedinBody.meta.creditsCharged, 0);

  const unknown = await callTool(app, GET_JOB_TOOL, {
    url: "https://example.com/careers/1",
  });
  assert.equal(unknown.isError, true);
  const unknownBody = unknown.structuredContent as ErrBody;
  assert.equal(unknownBody.error.code, "unsupported_board");
  assert.equal(unknownBody.meta.creditsCharged, 0);

  const gone = await callTool(app, LIST_BOARD_TOOL, { url: GONE_BOARD });
  assert.equal(gone.isError, true);
  const goneBody = gone.structuredContent as ErrBody;
  assert.equal(goneBody.error.code, "board_not_found");
  assert.equal(goneBody.meta.creditsCharged, 0);

  const missingTool = await callTool(app, "apply_job", { url: GH_STRIPE });
  assert.equal(missingTool.isError, true);
  const missingBody = missingTool.structuredContent as ErrBody;
  assert.equal(missingBody.error.code, "invalid_request");
  assert.equal(missingBody.meta.creditsCharged, 0);
  assert.equal(remainingCredits(db), 7);
});

test("MCP get_job unknown never-ingested 404 is job_closed, 0 credits", async () => {
  const { app, db } = await appWithKey(4);
  const mcp = await callTool(app, GET_JOB_TOOL, { url: GH_UNKNOWN_CLOSED });
  assert.equal(mcp.isError, true);
  const body = mcp.structuredContent as ErrBody;
  assert.equal(body.error.code, "job_closed");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(remainingCredits(db), 4);
});

test("zero-credit key cannot get_job or list_board", async () => {
  const { app } = await appWithKey(0);
  const job = await callTool(app, GET_JOB_TOOL, { url: GH_STRIPE });
  assert.equal(job.isError, true);
  assert.equal((job.structuredContent as ErrBody).error.code, "payment_required");
  assert.equal((job.structuredContent as ErrBody).meta.creditsCharged, 0);

  const board = await callTool(app, LIST_BOARD_TOOL, { url: GH_BOARD });
  assert.equal(board.isError, true);
  assert.equal((board.structuredContent as ErrBody).error.code, "payment_required");
  assert.equal((board.structuredContent as ErrBody).meta.creditsCharged, 0);
});

test("HTTP and MCP call core only and never fetch a live ATS", () => {
  const files = [...walkTs(join(ROOT, "src/http")), ...walkTs(join(ROOT, "src/mcp"))];
  assert.ok(files.length > 0);
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /adapters\//, file);
    assert.doesNotMatch(src, /\bfetch\s*\(/, file);
  }
  const tools = readFileSync(join(ROOT, "src/mcp/tools.ts"), "utf8");
  assert.match(tools, /getJobByUrl/);
  assert.match(tools, /getBoardByUrl/);
  assert.match(tools, /searchIngestedJobs/);
  assert.match(tools, /get_job/);
  assert.match(tools, /list_board/);
  assert.match(tools, /search_jobs/);
});
