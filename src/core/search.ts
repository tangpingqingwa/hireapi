import { toJobSummary } from "../adapters/parse.js";
import type { HireApiDb } from "../db.js";
import type { JobLocation, JobSummary, Source } from "../types.js";
import { HireError } from "./errors.js";
import { listStoredJobs } from "./store.js";

const ENABLED_SOURCES = new Set<Source>(["greenhouse", "ashby", "lever"]);

export type SearchQuery = {
  q?: string;
  location?: string;
  source?: string;
  remote?: string;
  cursor?: string;
};

export type SearchPage = {
  jobs: JobSummary[];
  nextCursor: null;
};

function parseSourceFilter(raw: string | undefined): Source | null {
  if (raw === undefined) {
    return null;
  }
  const source = raw.trim().toLowerCase();
  if (source === "") {
    return null;
  }
  if (source === "indeed" || source === "linkedin") {
    throw new HireError("source_disabled", "LinkedIn and Indeed are not enabled.");
  }
  if (!ENABLED_SOURCES.has(source as Source)) {
    throw new HireError(
      "invalid_request",
      "Query parameter source must be greenhouse, ashby, or lever.",
    );
  }
  return source as Source;
}

function parseRemoteFilter(raw: string | undefined): boolean | null {
  if (raw === undefined) {
    return null;
  }
  const token = raw.trim().toLowerCase();
  if (token === "") {
    return null;
  }
  if (token === "true" || token === "1" || token === "yes") {
    return true;
  }
  if (token === "false" || token === "0" || token === "no") {
    return false;
  }
  throw new HireError("invalid_request", "Query parameter remote must be true or false.");
}

function locationBlob(locations: readonly JobLocation[]): string {
  return locations
    .flatMap((loc) => [loc.raw, loc.city, loc.region, loc.country])
    .filter((part): part is string => part !== null && part !== "")
    .join(" ")
    .toLowerCase();
}

/**
 * Search already-ingested open jobs. Never fetches an ATS.
 */
export function searchIngestedJobs(db: HireApiDb, query: SearchQuery = {}): SearchPage {
  const q = (query.q ?? "").trim().toLowerCase();
  const location = (query.location ?? "").trim().toLowerCase();
  const source = parseSourceFilter(query.source);
  const remote = parseRemoteFilter(query.remote);

  const jobs = listStoredJobs(db)
    .filter((stored) => {
      const job = stored.job;
      if (job.closed) {
        return false;
      }
      if (source !== null && job.source !== source) {
        return false;
      }
      if (remote !== null && job.remote !== remote) {
        return false;
      }
      if (q !== "") {
        const hay = `${job.title} ${job.company.name}`.toLowerCase();
        if (!hay.includes(q)) {
          return false;
        }
      }
      if (location !== "" && !locationBlob(job.locations).includes(location)) {
        return false;
      }
      return true;
    })
    .map((stored) => toJobSummary(stored.job))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

  return { jobs, nextCursor: null };
}
