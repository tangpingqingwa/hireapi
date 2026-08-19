import type { HireApiDb } from "../db.js";
import type { Job, JobLocation, JobSummary, Salary, Source } from "../types.js";

export const OPEN_JOB_TTL_MS = 24 * 60 * 60 * 1000;

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
  employment_type: Job["employmentType"];
  salary_json: string | null;
  description_markdown: string | null;
  posted_at: string | null;
  closed: number;
  closed_at: string | null;
  fetched_at: string;
};

function parseLocations(raw: string): JobLocation[] {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as JobLocation[]) : [];
}

function parseSalaryJson(raw: string | null): Salary | null {
  if (raw === null) {
    return null;
  }
  return JSON.parse(raw) as Salary;
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    source: row.source,
    sourceJobId: row.source_job_id,
    title: row.title,
    company: { name: row.company_name, id: row.company_id },
    locations: parseLocations(row.locations_json),
    remote: row.remote === null ? null : row.remote === 1,
    employmentType: row.employment_type,
    salary: parseSalaryJson(row.salary_json),
    descriptionMarkdown: row.description_markdown ?? "",
    applyUrl: row.apply_url,
    postedAt: row.posted_at,
    closed: row.closed === 1,
    fetchedAt: row.fetched_at,
  };
}

export function getJobByApplyUrl(db: HireApiDb, applyUrl: string): Job | null {
  const row = db
    .prepare<[string], JobRow>("SELECT * FROM jobs WHERE apply_url = ?")
    .get(applyUrl);
  return row === undefined ? null : rowToJob(row);
}

export function getJobById(db: HireApiDb, id: string): Job | null {
  const row = db.prepare<[string], JobRow>("SELECT * FROM jobs WHERE id = ?").get(id);
  return row === undefined ? null : rowToJob(row);
}

export function listOpenJobsForBoard(db: HireApiDb, boardUrl: string): Job[] {
  return db
    .prepare<[string], JobRow>("SELECT * FROM jobs WHERE board_url = ? AND closed = 0")
    .all(boardUrl)
    .map(rowToJob);
}

export function upsertOpenJob(
  db: HireApiDb,
  job: Job,
  boardUrl: string | null = null,
): Job {
  const now = job.fetchedAt;
  db.prepare(
    `INSERT INTO jobs (
       id, source, source_job_id, apply_url, board_url, title, company_name, company_id,
       locations_json, remote, employment_type, salary_json, description_markdown,
       posted_at, closed, closed_at, fetched_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source = excluded.source,
       source_job_id = excluded.source_job_id,
       apply_url = excluded.apply_url,
       board_url = COALESCE(excluded.board_url, jobs.board_url),
       title = excluded.title,
       company_name = excluded.company_name,
       company_id = excluded.company_id,
       locations_json = excluded.locations_json,
       remote = excluded.remote,
       employment_type = excluded.employment_type,
       salary_json = excluded.salary_json,
       description_markdown = CASE
         WHEN excluded.description_markdown IS NOT NULL AND excluded.description_markdown != ''
         THEN excluded.description_markdown
         ELSE jobs.description_markdown
       END,
       posted_at = excluded.posted_at,
       closed = 0,
       closed_at = NULL,
       fetched_at = excluded.fetched_at`,
  ).run(
    job.id,
    job.source,
    job.sourceJobId,
    job.applyUrl,
    boardUrl,
    job.title,
    job.company.name,
    job.company.id,
    JSON.stringify(job.locations),
    job.remote === null ? null : job.remote ? 1 : 0,
    job.employmentType,
    job.salary === null ? null : JSON.stringify(job.salary),
    job.descriptionMarkdown,
    job.postedAt,
    now,
    now,
  );
  return { ...job, closed: false };
}

export function upsertOpenSummary(
  db: HireApiDb,
  summary: JobSummary,
  source: Source,
  sourceJobId: string | null,
  boardUrl: string,
  fetchedAt: string,
): JobSummary {
  db.prepare(
    `INSERT INTO jobs (
       id, source, source_job_id, apply_url, board_url, title, company_name, company_id,
       locations_json, remote, employment_type, salary_json, description_markdown,
       posted_at, closed, closed_at, fetched_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source = excluded.source,
       source_job_id = excluded.source_job_id,
       apply_url = excluded.apply_url,
       board_url = excluded.board_url,
       title = excluded.title,
       company_name = excluded.company_name,
       company_id = excluded.company_id,
       locations_json = excluded.locations_json,
       remote = excluded.remote,
       closed = 0,
       closed_at = NULL,
       fetched_at = excluded.fetched_at`,
  ).run(
    summary.id,
    source,
    sourceJobId,
    summary.applyUrl,
    boardUrl,
    summary.title,
    summary.company.name,
    summary.company.id,
    JSON.stringify(summary.locations),
    summary.remote === null ? null : summary.remote ? 1 : 0,
    fetchedAt,
    fetchedAt,
  );
  return { ...summary, closed: false, hasFullDescription: false };
}

export function markJobClosed(db: HireApiDb, applyUrl: string, closedAt: string): Job | null {
  db.prepare(
    `UPDATE jobs
     SET closed = 1,
         closed_at = COALESCE(closed_at, ?),
         description_markdown = '',
         fetched_at = ?
     WHERE apply_url = ?`,
  ).run(closedAt, closedAt, applyUrl);
  return getJobByApplyUrl(db, applyUrl);
}

export function closeJobsOmittedFromBoard(
  db: HireApiDb,
  boardUrl: string,
  openApplyUrls: readonly string[],
  closedAt: string,
): Job[] {
  const open = listOpenJobsForBoard(db, boardUrl);
  const keep = new Set(openApplyUrls);
  const closed: Job[] = [];
  for (const job of open) {
    if (!keep.has(job.applyUrl)) {
      const next = markJobClosed(db, job.applyUrl, closedAt);
      if (next !== null) {
        closed.push(next);
      }
    }
  }
  return closed;
}

export function closedJobFromKnown(job: Job, closedAt: string): Job {
  return {
    ...job,
    closed: true,
    descriptionMarkdown: "",
    fetchedAt: closedAt,
  };
}

export function isFreshOpenJob(job: Job, nowMs = Date.now()): boolean {
  if (job.closed) {
    return false;
  }
  if (job.descriptionMarkdown.trim() === "") {
    return false;
  }
  const fetched = Date.parse(job.fetchedAt);
  if (Number.isNaN(fetched)) {
    return false;
  }
  return nowMs - fetched < OPEN_JOB_TTL_MS;
}


