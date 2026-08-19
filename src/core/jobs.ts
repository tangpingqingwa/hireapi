import { normalizeUrl } from "../adapters/parse.js";
import type { HireApiDb } from "../db.js";
import type { BoardAdapter, Job } from "../types.js";
import { defaultAdapters } from "./boards.js";
import { HireError } from "./errors.js";
import {
  closedJobFromKnown,
  getJobByApplyUrl,
  isFreshOpenJob,
  markJobClosed,
  upsertOpenJob,
} from "./store.js";

export { defaultAdapters };

export function adapterForJobUrl(
  url: string,
  adapters: readonly BoardAdapter[] = defaultAdapters(),
): BoardAdapter | null {
  for (const adapter of adapters) {
    if (adapter.matchJobUrl(url)) {
      return adapter;
    }
  }
  return null;
}

export function parseJobUrl(raw: string): string {
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
  return trimmed;
}

export async function getJobByUrl(
  url: string,
  adapters: readonly BoardAdapter[] = defaultAdapters(),
  db?: HireApiDb,
): Promise<Job> {
  const trimmed = parseJobUrl(url);
  const adapter = adapterForJobUrl(trimmed, adapters);
  if (adapter === null) {
    throw new HireError(
      "unsupported_board",
      "URL is not a Greenhouse or Ashby job posting we parse.",
    );
  }
  const applyUrl = normalizeUrl(trimmed) ?? trimmed;
  const known = db !== undefined ? getJobByApplyUrl(db, applyUrl) : null;
  if (known !== null && known.closed) {
    return known;
  }
  if (known !== null && isFreshOpenJob(known)) {
    return known;
  }
  try {
    const job = await adapter.fetchJob(trimmed);
    if (db !== undefined) {
      return upsertOpenJob(db, job);
    }
    return job;
  } catch (err) {
    if (err instanceof HireError && err.code === "job_closed") {
      const closedAt = new Date().toISOString();
      if (db !== undefined && known !== null) {
        return markJobClosed(db, applyUrl, closedAt) ?? closedJobFromKnown(known, closedAt);
      }
      if (known !== null) {
        return closedJobFromKnown(known, closedAt);
      }
      throw err;
    }
    throw err;
  }
}
