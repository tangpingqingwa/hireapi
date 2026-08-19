import { parseAshbyJobSlug } from "../adapters/ashby.js";
import { parseGreenhouseJobId } from "../adapters/greenhouse.js";
import { parseLeverJobId } from "../adapters/lever.js";
import { inferBoardUrl, normalizeUrl } from "../adapters/parse.js";
import type { HireApiDb } from "../db.js";
import type { BoardAdapter, JobSummary } from "../types.js";
import { HireError } from "./errors.js";
import { adapterForBoardUrl, defaultAdapters, parseRequestedUrl } from "./router.js";
import {
  closeAllJobsOnBoard,
  closeJobsOmittedFromBoard,
  listStoredJobsForBoard,
  upsertJobSummary,
} from "./store.js";

export type GetBoardByUrlOptions = {
  adapters?: readonly BoardAdapter[];
  now?: Date;
};

export type BoardList = {
  jobs: JobSummary[];
  nextCursor: null;
};

function sourceJobIdForSummary(vendor: BoardAdapter["vendor"], applyUrl: string): string | null {
  if (vendor === "greenhouse") {
    return parseGreenhouseJobId(applyUrl);
  }
  if (vendor === "ashby") {
    return parseAshbyJobSlug(applyUrl);
  }
  if (vendor === "lever") {
    return parseLeverJobId(applyUrl);
  }
  return null;
}

export async function getBoardByUrl(
  url: string,
  db: HireApiDb,
  options: GetBoardByUrlOptions = {},
): Promise<BoardList> {
  const adapters = options.adapters ?? defaultAdapters();
  const now = options.now ?? new Date();
  const trimmed = parseRequestedUrl(url);
  const adapter = adapterForBoardUrl(trimmed, adapters);
  if (adapter === null) {
    throw new HireError(
      "unsupported_board",
      "URL is not a Greenhouse, Ashby, or Lever board we parse.",
    );
  }
  const boardUrl = inferBoardUrl(trimmed) ?? normalizeUrl(trimmed) ?? trimmed;
  let summaries: JobSummary[];
  try {
    summaries = await adapter.fetchBoard(trimmed);
  } catch (err) {
    if (err instanceof HireError && err.code === "board_not_found") {
      closeAllJobsOnBoard(db, boardUrl, now);
    }
    throw err;
  }
  const openApplyUrls = new Set<string>();
  for (const summary of summaries) {
    if (summary.closed) {
      continue;
    }
    const apply = normalizeUrl(summary.applyUrl) ?? summary.applyUrl;
    openApplyUrls.add(apply);
    upsertJobSummary(
      db,
      { ...summary, applyUrl: apply, hasFullDescription: false },
      adapter.vendor,
      sourceJobIdForSummary(adapter.vendor, apply),
      boardUrl,
      now,
    );
  }
  closeJobsOmittedFromBoard(db, boardUrl, openApplyUrls, now);
  const jobs = listStoredJobsForBoard(db, boardUrl)
    .filter((stored) => !stored.job.closed)
    .map((stored) => ({
      id: stored.job.id,
      title: stored.job.title,
      company: stored.job.company,
      locations: stored.job.locations,
      remote: stored.job.remote,
      applyUrl: stored.job.applyUrl,
      closed: false,
      hasFullDescription: false as const,
    }));
  return { jobs, nextCursor: null };
}
