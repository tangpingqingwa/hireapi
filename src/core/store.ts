import type { HireApiDb } from "../db.js";
import { normalizeUrl } from "../adapters/parse.js";
import type {
  EmploymentType,
  Job,
  JobLocation,
  JobSummary,
  Salary,
  Source,
} from "../types.js";

export const OPEN_JOB_CACHE_MS = 24 * 60 * 60 * 1000;

type JobRow = {
  id: string;
  source: Source;
  source_job_id: string | null;
  apply_url: string;
  board_url: string | null;
  title: string;
  company_name: string;
  company_id: string | null;
  locations_json: string;
  remote: number | null;
  employment_type: string | null;
  salary_json: string | null;
  description_markdown: string;
  has_full_description: number;
  posted_at: string | null;
  closed: number;
  closed_at: string | null;
  fetched_at: string;
  created_at: string;
};

export type StoredJob = {
  job: Job;
  boardUrl: string | null;
  hasFullDescription: boolean;
};

function parseLocations(raw: string): JobLocation[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed as JobLocation[];
}

function parseSalaryJson(raw: string | null): Salary | null {
  if (raw === null || raw === "") {
    return null;
  }
  return JSON.parse(raw) as Salary;
}

function remoteFromRow(value: number | null): boolean | null {
  if (value === null) {
    return null;
  }
  return value === 1;
}

function rowToJob(row: JobRow): Job {
  const closed = row.closed === 1;
  return {
    id: row.id,
    source: row.source,
    sourceJobId: row.source_job_id,
    title: row.title,
    company: { name: row.company_name, id: row.company_id },
    locations: parseLocations(row.locations_json),
    remote: remoteFromRow(row.remote),
    employmentType: row.employment_type as EmploymentType | null,
    salary: parseSalaryJson(row.salary_json),
    descriptionMarkdown: closed ? "" : row.description_markdown,
    applyUrl: row.apply_url,
    postedAt: row.posted_at,
    closed,
    closedAt: row.closed_at,
    fetchedAt: row.fetched_at,
  };
}

function rowToStored(row: JobRow): StoredJob {
  return {
    job: rowToJob(row),
    boardUrl: row.board_url,
    hasFullDescription: row.has_full_description === 1 && row.closed === 0,
  };
}

function lookupKeys(url: string): string[] {
  const keys = new Set<string>();
  const trimmed = url.trim();
  if (trimmed !== "") {
    keys.add(trimmed);
  }
  const normalized = normalizeUrl(trimmed);
  if (normalized !== null) {
    keys.add(normalized);
  }
  return [...keys];
}

export function findStoredJob(db: HireApiDb, url: string): StoredJob | null {
  const select = db.prepare<[string], JobRow>("SELECT * FROM jobs WHERE apply_url = ?");
  for (const key of lookupKeys(url)) {
    const row = select.get(key);
    if (row !== undefined) {
      return rowToStored(row);
    }
  }
  return null;
}

export function listStoredJobsForBoard(db: HireApiDb, boardUrl: string): StoredJob[] {
  const key = normalizeUrl(boardUrl) ?? boardUrl;
  return db
    .prepare<[string], JobRow>("SELECT * FROM jobs WHERE board_url = ?")
    .all(key)
    .map(rowToStored);
}

export function listStoredJobs(db: HireApiDb): StoredJob[] {
  return db.prepare<[], JobRow>("SELECT * FROM jobs").all().map(rowToStored);
}

export function listStoredJobsForCompany(db: HireApiDb, companyId: string): StoredJob[] {
  return db
    .prepare<[string], JobRow>("SELECT * FROM jobs WHERE company_id = ?")
    .all(companyId)
    .map(rowToStored);
}

export function isFreshOpenFullJob(stored: StoredJob, now: Date): boolean {
  if (stored.job.closed || !stored.hasFullDescription) {
    return false;
  }
  const fetched = Date.parse(stored.job.fetchedAt);
  if (Number.isNaN(fetched)) {
    return false;
  }
  return now.getTime() - fetched < OPEN_JOB_CACHE_MS;
}

function remoteToInt(remote: boolean | null): number | null {
  if (remote === null) {
    return null;
  }
  return remote ? 1 : 0;
}

export function upsertFullJob(
  db: HireApiDb,
  job: Job,
  boardUrl: string | null,
  now: Date = new Date(),
): Job {
  const applyUrl = normalizeUrl(job.applyUrl) ?? job.applyUrl;
  const board = boardUrl !== null ? (normalizeUrl(boardUrl) ?? boardUrl) : null;
  const existing = findStoredJob(db, applyUrl);
  const fetchedAt = now.toISOString();
  if (existing !== null) {
    db.prepare(
      `UPDATE jobs SET
         source = ?, source_job_id = ?, apply_url = ?, board_url = COALESCE(?, board_url),
         title = ?, company_name = ?, company_id = ?, locations_json = ?, remote = ?,
         employment_type = ?, salary_json = ?, description_markdown = ?, has_full_description = 1,
         posted_at = ?, closed = 0, closed_at = NULL, fetched_at = ?
       WHERE id = ?`,
    ).run(
      job.source,
      job.sourceJobId,
      applyUrl,
      board,
      job.title,
      job.company.name,
      job.company.id,
      JSON.stringify(job.locations),
      remoteToInt(job.remote),
      job.employmentType,
      job.salary === null ? null : JSON.stringify(job.salary),
      job.descriptionMarkdown,
      job.postedAt,
      fetchedAt,
      existing.job.id,
    );
    return { ...job, id: existing.job.id, applyUrl, closed: false, closedAt: null, fetchedAt };
  }
  db.prepare(
    `INSERT INTO jobs (
       id, source, source_job_id, apply_url, board_url, title, company_name, company_id,
       locations_json, remote, employment_type, salary_json, description_markdown,
       has_full_description, posted_at, closed, closed_at, fetched_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, NULL, ?, ?)`,
  ).run(
    job.id,
    job.source,
    job.sourceJobId,
    applyUrl,
    board,
    job.title,
    job.company.name,
    job.company.id,
    JSON.stringify(job.locations),
    remoteToInt(job.remote),
    job.employmentType,
    job.salary === null ? null : JSON.stringify(job.salary),
    job.descriptionMarkdown,
    job.postedAt,
    fetchedAt,
    fetchedAt,
  );
  return { ...job, applyUrl, closed: false, closedAt: null, fetchedAt };
}

export function upsertJobSummary(
  db: HireApiDb,
  summary: JobSummary,
  source: Source,
  sourceJobId: string | null,
  boardUrl: string,
  now: Date,
): void {
  const applyUrl = normalizeUrl(summary.applyUrl) ?? summary.applyUrl;
  const board = normalizeUrl(boardUrl) ?? boardUrl;
  const existing = findStoredJob(db, applyUrl);
  const fetchedAt = now.toISOString();
  if (existing !== null) {
    db.prepare(
      `UPDATE jobs SET
         apply_url = ?, board_url = ?, title = ?, company_name = ?, company_id = ?,
         locations_json = ?, remote = ?, closed = 0, closed_at = NULL, fetched_at = ?
       WHERE id = ?`,
    ).run(
      applyUrl,
      board,
      summary.title,
      summary.company.name,
      summary.company.id,
      JSON.stringify(summary.locations),
      remoteToInt(summary.remote),
      fetchedAt,
      existing.job.id,
    );
    return;
  }
  db.prepare(
    `INSERT INTO jobs (
       id, source, source_job_id, apply_url, board_url, title, company_name, company_id,
       locations_json, remote, employment_type, salary_json, description_markdown,
       has_full_description, posted_at, closed, closed_at, fetched_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '', 0, NULL, 0, NULL, ?, ?)`,
  ).run(
    summary.id,
    source,
    sourceJobId,
    applyUrl,
    board,
    summary.title,
    summary.company.name,
    summary.company.id,
    JSON.stringify(summary.locations),
    remoteToInt(summary.remote),
    fetchedAt,
    fetchedAt,
  );
}

export function closeStoredJob(db: HireApiDb, id: string, now: Date): StoredJob {
  const existing = db.prepare<[string], JobRow>("SELECT * FROM jobs WHERE id = ?").get(id);
  if (existing === undefined) {
    throw new Error(`jobs row missing before close: ${id}`);
  }
  if (existing.closed === 1) {
    return rowToStored(existing);
  }
  const closedAt = now.toISOString();
  db.prepare(
    `UPDATE jobs SET
       closed = 1, closed_at = ?, description_markdown = '', has_full_description = 0, fetched_at = ?
     WHERE id = ?`,
  ).run(closedAt, closedAt, id);
  const row = db.prepare<[string], JobRow>("SELECT * FROM jobs WHERE id = ?").get(id);
  if (row === undefined) {
    throw new Error(`jobs row missing after close: ${id}`);
  }
  return rowToStored(row);
}

export function closeJobsOmittedFromBoard(
  db: HireApiDb,
  boardUrl: string,
  openApplyUrls: ReadonlySet<string>,
  now: Date,
): void {
  for (const stored of listStoredJobsForBoard(db, boardUrl)) {
    if (stored.job.closed) {
      continue;
    }
    const apply = normalizeUrl(stored.job.applyUrl) ?? stored.job.applyUrl;
    if (!openApplyUrls.has(apply)) {
      closeStoredJob(db, stored.job.id, now);
    }
  }
}

export function closeAllJobsOnBoard(db: HireApiDb, boardUrl: string, now: Date): void {
  closeJobsOmittedFromBoard(db, boardUrl, new Set(), now);
}
