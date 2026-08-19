export type Source = "greenhouse" | "ashby" | "lever" | "indeed" | "linkedin";

export type AdapterVendor = "greenhouse" | "ashby" | "lever";

export type EmploymentType =
  | "full_time"
  | "part_time"
  | "contract"
  | "intern"
  | "other";

export type SalaryPeriod = "year" | "hour" | "month";

export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "payment_required"
  | "not_found"
  | "job_closed"
  | "board_not_found"
  | "unsupported_board"
  | "source_disabled"
  | "rate_limited"
  | "upstream_blocked"
  | "internal";

export const ERROR_CODES: readonly ErrorCode[] = [
  "invalid_request",
  "unauthorized",
  "payment_required",
  "not_found",
  "job_closed",
  "board_not_found",
  "unsupported_board",
  "source_disabled",
  "rate_limited",
  "upstream_blocked",
  "internal",
];

export type Ok<T> = {
  data: T;
  meta: {
    cached: boolean;
    creditsCharged: number;
    requestId: string;
    upstreamMs: number;
  };
};

export type Err = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: 0; requestId: string };
};

export type JobLocation = {
  raw: string;
  city: string | null;
  region: string | null;
  country: string | null;
};

export type Salary = {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: SalaryPeriod | null;
  raw: string | null;
};

export type CompanyRef = {
  name: string;
  id: string | null;
};

/** Full job record returned by GET /v1/jobs/by-url. */
export type Job = {
  id: string;
  source: Source;
  sourceJobId: string | null;
  title: string;
  company: CompanyRef;
  locations: JobLocation[];
  remote: boolean | null;
  employmentType: EmploymentType | null;
  salary: Salary | null;
  descriptionMarkdown: string;
  applyUrl: string;
  postedAt: string | null;
  closed: boolean;
  closedAt: string | null;
  fetchedAt: string;
};

/**
 * Board list row. Full Markdown is only on by-url (BUILD: summaries only).
 * hasFullDescription is always false on this type.
 */
export type JobSummary = {
  id: string;
  title: string;
  company: CompanyRef;
  locations: JobLocation[];
  remote: boolean | null;
  applyUrl: string;
  closed: boolean;
  hasFullDescription: false;
};

export type BoardAdapter = {
  vendor: AdapterVendor;
  matchJobUrl(url: string): boolean;
  matchBoardUrl(url: string): boolean;
  fetchJob(url: string): Promise<Job>;
  fetchBoard(url: string): Promise<JobSummary[]>;
};
