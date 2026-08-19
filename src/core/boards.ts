import { createAshbyAdapter, parseAshbyJobSlug } from "../adapters/ashby.js";
import { createFixtureFetchPage } from "../adapters/fixtures.js";
import { createGreenhouseAdapter, parseGreenhouseJobId } from "../adapters/greenhouse.js";
import { normalizeUrl } from "../adapters/parse.js";
import type { FetchPage } from "../adapters/transport.js";
import type { HireApiDb } from "../db.js";
import type { BoardAdapter, JobSummary } from "../types.js";
import { HireError } from "./errors.js";
import {
  closeJobsOmittedFromBoard,
  upsertOpenSummary,
} from "./store.js";

export function defaultAdapters(fetchPage: FetchPage = createFixtureFetchPage()): BoardAdapter[] {
  return [createGreenhouseAdapter(fetchPage), createAshbyAdapter(fetchPage)];
}

export function adapterForBoardUrl(
  url: string,
  adapters: readonly BoardAdapter[] = defaultAdapters(),
): BoardAdapter | null {
  for (const adapter of adapters) {
    if (adapter.matchBoardUrl(url)) {
      return adapter;
    }
  }
  return null;
}

export function parseBoardUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new HireError("invalid_request", "Query parameter url is required.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HireError("invalid_request", "Query parameter url must be an absolute URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HireError("invalid_request", "Query parameter url must be http or https.");
  }
  const host = parsed.hostname.toLowerCase();
  if (host.includes("linkedin.com") || host.includes("indeed.com") || host.includes("indeed.")) {
    throw new HireError("source_disabled", "LinkedIn and Indeed are not enabled.");
  }
  return parsed;
}

function sourceJobIdFor(adapter: BoardAdapter, applyUrl: string): string | null {
  if (adapter.vendor === "greenhouse") {
    return parseGreenhouseJobId(applyUrl);
  }
  if (adapter.vendor === "ashby") {
    return parseAshbyJobSlug(applyUrl);
  }
  return null;
}

export type BoardPage = {
  jobs: JobSummary[];
  nextCursor: string | null;
};

const DEFAULT_PAGE_SIZE = 50;

export function paginateSummaries(
  jobs: readonly JobSummary[],
  cursor: string | undefined,
  pageSize = DEFAULT_PAGE_SIZE,
): BoardPage {
  const start = cursor === undefined || cursor === "" ? 0 : Number.parseInt(cursor, 10);
  if (!Number.isInteger(start) || start < 0) {
    throw new HireError("invalid_request", "Query parameter cursor must be a non-negative integer.");
  }
  const slice = jobs.slice(start, start + pageSize);
  const next = start + pageSize < jobs.length ? String(start + pageSize) : null;
  return { jobs: slice, nextCursor: next };
}

export async function getBoardByUrl(
  url: string,
  db: HireApiDb,
  adapters: readonly BoardAdapter[] = defaultAdapters(),
): Promise<JobSummary[]> {
  const parsed = parseBoardUrl(url);
  const trimmed = parsed.toString();
  const adapter = adapterForBoardUrl(trimmed, adapters);
  if (adapter === null) {
    throw new HireError(
      "unsupported_board",
      "URL is not a Greenhouse or Ashby board we parse.",
    );
  }
  const boardUrl = normalizeUrl(trimmed) ?? trimmed;
  const fetchedAt = new Date().toISOString();
  let summaries: JobSummary[];
  try {
    summaries = await adapter.fetchBoard(trimmed);
  } catch (err) {
    if (err instanceof HireError && err.code === "board_not_found") {
      closeJobsOmittedFromBoard(db, boardUrl, [], fetchedAt);
    }
    throw err;
  }
  const openUrls: string[] = [];
  const persisted: JobSummary[] = [];
  for (const summary of summaries) {
    if (summary.closed) {
      continue;
    }
    openUrls.push(summary.applyUrl);
    persisted.push(
      upsertOpenSummary(
        db,
        summary,
        adapter.vendor,
        sourceJobIdFor(adapter, summary.applyUrl),
        boardUrl,
        fetchedAt,
      ),
    );
  }
  closeJobsOmittedFromBoard(db, boardUrl, openUrls, fetchedAt);
  return persisted;
}
