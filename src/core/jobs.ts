import { inferBoardUrl } from "../adapters/parse.js";
import type { HireApiDb } from "../db.js";
import type { BoardAdapter, Job } from "../types.js";
import { HireError } from "./errors.js";
import { adapterForJobUrl, defaultAdapters, parseRequestedUrl } from "./router.js";
import {
  closeStoredJob,
  findStoredJob,
  isFreshOpenFullJob,
  upsertFullJob,
} from "./store.js";

export { adapterForJobUrl, defaultAdapters } from "./router.js";

export type GetJobByUrlOptions = {
  adapters?: readonly BoardAdapter[];
  db?: HireApiDb;
  now?: Date;
};

function isAdapterList(
  value: readonly BoardAdapter[] | GetJobByUrlOptions,
): value is readonly BoardAdapter[] {
  return Array.isArray(value);
}

export async function getJobByUrl(
  url: string,
  adaptersOrOptions: readonly BoardAdapter[] | GetJobByUrlOptions = defaultAdapters(),
): Promise<Job> {
  const options: GetJobByUrlOptions = isAdapterList(adaptersOrOptions)
    ? { adapters: adaptersOrOptions }
    : adaptersOrOptions;
  const adapters = options.adapters ?? defaultAdapters();
  const now = options.now ?? new Date();
  const trimmed = parseRequestedUrl(url);
  const adapter = adapterForJobUrl(trimmed, adapters);
  if (adapter === null) {
    throw new HireError(
      "unsupported_board",
      "URL is not a Greenhouse, Ashby, or Lever job posting we parse.",
    );
  }
  const db = options.db;
  if (db !== undefined) {
    const stored = findStoredJob(db, trimmed);
    if (stored !== null && isFreshOpenFullJob(stored, now)) {
      return stored.job;
    }
  }
  try {
    const job = await adapter.fetchJob(trimmed);
    if (db === undefined) {
      return job;
    }
    return upsertFullJob(db, job, inferBoardUrl(job.applyUrl) ?? inferBoardUrl(trimmed), now);
  } catch (err) {
    if (err instanceof HireError && err.code === "job_closed" && db !== undefined) {
      const stored = findStoredJob(db, trimmed);
      if (stored !== null) {
        if (stored.job.closed) {
          return stored.job;
        }
        return closeStoredJob(db, stored.job.id, now).job;
      }
    }
    throw err;
  }
}
