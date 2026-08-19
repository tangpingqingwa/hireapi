import { tryChargeOrPaymentRequired } from "../billing/charge.js";
import type { Key } from "../billing/keys.js";
import { getBoardByUrl } from "../core/boards.js";
import { HireError } from "../core/errors.js";
import { getJobByUrl } from "../core/jobs.js";
import { searchIngestedJobs } from "../core/search.js";
import type { HireApiDb } from "../db.js";
import { isRetryable, newRequestId } from "../http/envelope.js";
import { BOARDS_BY_URL_PATH } from "../http/routes/boards.js";
import { JOBS_BY_URL_PATH } from "../http/routes/jobs.js";
import { SEARCH_PATH } from "../http/routes/search.js";
import type { Err, ErrorCode, JobSummary, Ok } from "../types.js";

export const GET_JOB_TOOL = "get_job" as const;
export const LIST_BOARD_TOOL = "list_board" as const;
export const SEARCH_JOBS_TOOL = "search_jobs" as const;

export const MCP_TOOL_NAMES = [GET_JOB_TOOL, LIST_BOARD_TOOL, SEARCH_JOBS_TOOL] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export type McpToolDefinition = {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolOutcome = Ok<unknown> | Err;

export type CallMcpToolInput = {
  name: string;
  args: Record<string, unknown>;
  db: HireApiDb;
  key: Key;
  requestId?: string;
};

export const MCP_SKILL =
  "Apply links go to the source ATS. We do not apply. Salary may be null. LinkedIn is not available.";

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: GET_JOB_TOOL,
    description:
      "One public Greenhouse, Ashby, or Lever job. Maps to GET /v1/jobs/by-url. " +
      "1 credit on success. Failures charge 0. Salary is only present when the posting lists it. " +
      MCP_SKILL,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "Greenhouse, Ashby, or Lever job URL",
        },
      },
    },
  },
  {
    name: LIST_BOARD_TOOL,
    description:
      "Open jobs on a public ATS board as summaries (no descriptionMarkdown). " +
      "Maps to GET /v1/boards/by-url. 1 credit per open job returned; empty open board is 0. " +
      MCP_SKILL,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "Greenhouse, Ashby, or Lever board URL",
        },
        cursor: {
          type: "string",
          description: "Page token; accepted and unused when the board fits one page",
        },
      },
    },
  },
  {
    name: SEARCH_JOBS_TOOL,
    description:
      "Search already-ingested open jobs. Maps to GET /v1/search. Never fetches an ATS. " +
      "1 credit per hit; empty is 0. LinkedIn and Indeed are source_disabled. " +
      MCP_SKILL,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        q: {
          type: "string",
          description: "Substring match on title or company name",
        },
        location: {
          type: "string",
          description: "Substring match on any location field",
        },
        source: {
          type: "string",
          enum: ["greenhouse", "ashby", "lever"],
          description: "ATS filter. LinkedIn and Indeed are not enabled.",
        },
        remote: {
          description: "true or false",
        },
        cursor: {
          type: "string",
          description: "Page token; accepted and unused when the page fits",
        },
      },
    },
  },
];

export function isMcpToolName(name: string): name is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** Dispatch an MCP tool to core/* only. */
export async function callMcpTool(input: CallMcpToolInput): Promise<McpToolOutcome> {
  const requestId = input.requestId ?? newRequestId();
  if (!isMcpToolName(input.name)) {
    return fail("invalid_request", requestId, `Unknown MCP tool '${input.name}'.`);
  }
  switch (input.name) {
    case GET_JOB_TOOL:
      return dispatchGetJob(input, requestId);
    case LIST_BOARD_TOOL:
      return dispatchListBoard(input, requestId);
    case SEARCH_JOBS_TOOL:
      return dispatchSearchJobs(input, requestId);
  }
}

async function dispatchGetJob(
  input: CallMcpToolInput,
  requestId: string,
): Promise<McpToolOutcome> {
  if (input.key.credits < 1) {
    return fail("payment_required", requestId, "Not enough credits.");
  }
  const started = Date.now();
  try {
    const job = await getJobByUrl(readStringArg(input.args, "url") ?? "", {
      db: input.db,
    });
    const billed = chargeIfNeeded(input, requestId, 1, JOBS_BY_URL_PATH);
    if (billed !== null) {
      return billed;
    }
    return ok(job, requestId, 1, Date.now() - started);
  } catch (err) {
    return fromHireError(err, requestId);
  }
}

async function dispatchListBoard(
  input: CallMcpToolInput,
  requestId: string,
): Promise<McpToolOutcome> {
  const started = Date.now();
  try {
    const board = await getBoardByUrl(readStringArg(input.args, "url") ?? "", input.db);
    const data: JobSummary[] = board.jobs
      .filter((row) => !row.closed)
      .map((row) => ({ ...row, hasFullDescription: false }));
    const credits = data.length;
    const billed = chargeIfNeeded(input, requestId, credits, BOARDS_BY_URL_PATH);
    if (billed !== null) {
      return billed;
    }
    return ok(data, requestId, credits, Date.now() - started);
  } catch (err) {
    return fromHireError(err, requestId);
  }
}

async function dispatchSearchJobs(
  input: CallMcpToolInput,
  requestId: string,
): Promise<McpToolOutcome> {
  const started = Date.now();
  try {
    const page = searchIngestedJobs(input.db, {
      q: readStringArg(input.args, "q"),
      location: readStringArg(input.args, "location"),
      source: readStringArg(input.args, "source"),
      remote: readRemoteArg(input.args, "remote"),
      cursor: readStringArg(input.args, "cursor"),
    });
    const data: JobSummary[] = page.jobs.map((row) => ({
      ...row,
      hasFullDescription: false,
    }));
    const credits = data.length;
    const billed = chargeIfNeeded(input, requestId, credits, SEARCH_PATH);
    if (billed !== null) {
      return billed;
    }
    return ok(data, requestId, credits, Date.now() - started);
  } catch (err) {
    return fromHireError(err, requestId);
  }
}

function chargeIfNeeded(
  input: CallMcpToolInput,
  requestId: string,
  credits: number,
  route: string,
): Err | null {
  if (credits < 1) {
    return null;
  }
  if (input.key.credits < credits) {
    return fail("payment_required", requestId, "Not enough credits.");
  }
  const charged = tryChargeOrPaymentRequired(input.db, input.key, credits, route);
  if (!charged.ok) {
    return fail("payment_required", requestId, "Not enough credits.");
  }
  return null;
}

function ok(
  data: unknown,
  requestId: string,
  creditsCharged: number,
  upstreamMs: number,
): Ok<unknown> {
  return {
    data,
    meta: {
      cached: false,
      creditsCharged,
      requestId,
      upstreamMs,
    },
  };
}

function fail(code: ErrorCode, requestId: string, message: string): Err {
  return {
    error: { code, message, retryable: isRetryable(code) },
    meta: { creditsCharged: 0, requestId },
  };
}

function fromHireError(err: unknown, requestId: string): Err {
  if (err instanceof HireError) {
    return fail(err.code, requestId, err.message);
  }
  throw err;
}

function readStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function readRemoteArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return readStringArg(args, key);
}
