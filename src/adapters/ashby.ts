import { HireError } from "../core/errors.js";
import type { BoardAdapter, Job, JobSummary } from "../types.js";
import {
  asRecord,
  asString,
  buildJob,
  extractJsonLdJobPosting,
  findSalaryInText,
  firstMatch,
  hostOf,
  inferRemoteFromParts,
  innerHtml,
  locationsFromJsonLd,
  normalizeUrl,
  organizationName,
  parseEmploymentType,
  parseIsoDate,
  parseLocation,
  remoteFromJsonLd,
  salaryFromJsonLd,
  stripTags,
} from "./parse.js";
import type { FetchPage } from "./transport.js";

const JOB_HOSTS = new Set(["jobs.ashbyhq.com", "ashbyhq.com"]);

export function matchAshbyJobUrl(url: string): boolean {
  const host = hostOf(url);
  if (host === null || !JOB_HOSTS.has(host)) {
    return false;
  }
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  return parts.length >= 2;
}

export function matchAshbyBoardUrl(url: string): boolean {
  const host = hostOf(url);
  if (host === null || !JOB_HOSTS.has(host)) {
    return false;
  }
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  return parts.length === 1;
}

export function parseAshbyJobSlug(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    const last = parts[parts.length - 1];
    if (last === "application" && parts.length >= 3) {
      return parts[parts.length - 2];
    }
    return last;
  } catch {
    return null;
  }
}

function ashbyCompanyFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[0] ?? null;
  } catch {
    return null;
  }
}

function extractAshbyBootstrap(html: string): Record<string, unknown> | null {
  const patterns = [
    /<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /window\.__appData\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/i,
    /<script\b[^>]*data-ashby=["']job["'][^>]*>([\s\S]*?)<\/script>/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match === null) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(match[1]);
      const rec = asRecord(parsed);
      if (rec !== null) {
        return rec;
      }
    } catch {
      // try next
    }
  }
  return null;
}

function jobRecordFromBootstrap(data: Record<string, unknown>): Record<string, unknown> | null {
  const direct =
    asRecord(data.jobPosting) ??
    asRecord(data.job) ??
    asRecord(data.posting);
  if (direct !== null) {
    return direct;
  }
  const props = asRecord(data.props);
  const pageProps = props !== null ? asRecord(props.pageProps) : null;
  if (pageProps !== null) {
    return (
      asRecord(pageProps.jobPosting) ??
      asRecord(pageProps.job) ??
      asRecord(pageProps.posting)
    );
  }
  return null;
}

export function parseAshbyJobHtml(html: string, url: string, fetchedAt: string): Job {
  const sourceJobId = parseAshbyJobSlug(url);
  if (sourceJobId === null) {
    throw new HireError("invalid_request", "Ashby job URL is missing a job slug.");
  }
  const posting = extractJsonLdJobPosting(html);
  const bootstrap = extractAshbyBootstrap(html);
  const jobRec = bootstrap !== null ? jobRecordFromBootstrap(bootstrap) : null;
  const title =
    firstMatch(html, [
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
      /<div\b[^>]*class=["'][^"']*ashby-job-posting-heading[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    ]) ??
    asString(jobRec?.title) ??
    (typeof posting?.title === "string" ? posting.title : null);
  if (title === null || title === "") {
    throw new HireError("internal", "Ashby job page is missing a title.");
  }
  const company =
    firstMatch(html, [
      /<div\b[^>]*class=["'][^"']*ashby-job-posting-company-name[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      /<span\b[^>]*class=["'][^"']*company-name[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    ]) ??
    asString(jobRec?.departmentName) ??
    organizationName(posting?.hiringOrganization) ??
    ashbyCompanyFromUrl(url);
  if (company === null || company === "") {
    throw new HireError("internal", "Ashby job page is missing a company.");
  }
  const locationRaw =
    firstMatch(html, [
      /<div\b[^>]*class=["'][^"']*ashby-job-posting-location[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      /<p\b[^>]*class=["'][^"']*location[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    ]) ?? asString(jobRec?.locationName);
  const locations =
    locationRaw !== null
      ? [parseLocation(locationRaw)]
      : posting !== null
        ? locationsFromJsonLd(posting)
        : [];
  const descriptionHtml =
    innerHtml(html, { className: "ashby-job-posting-section" }) ??
    innerHtml(html, { id: "overview" }) ??
    asString(jobRec?.descriptionHtml) ??
    (typeof posting?.description === "string" ? posting.description : "");
  const compensationText =
    asString(jobRec?.compensationTierSummary) ??
    firstMatch(html, [
      /<div\b[^>]*class=["'][^"']*ashby-job-posting-compensation[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    ]);
  const salary =
    (compensationText !== null ? findSalaryInText(compensationText) : null) ??
    findSalaryInText(stripTags(descriptionHtml)) ??
    (posting !== null ? salaryFromJsonLd(posting) : null);
  const applyUrl = normalizeUrl(url) ?? url;
  const remote = inferRemoteFromParts(
    locationRaw,
    `${compensationText ?? ""} ${stripTags(descriptionHtml)}`,
    posting !== null ? remoteFromJsonLd(posting) : null,
  );
  return buildJob({
    source: "ashby",
    sourceJobId,
    title,
    companyName: company,
    locations,
    remote,
    employmentType:
      parseEmploymentType(jobRec?.employmentType) ??
      (posting !== null ? parseEmploymentType(posting.employmentType) : null),
    salary,
    descriptionHtml,
    applyUrl,
    postedAt:
      parseIsoDate(jobRec?.publishedDate) ??
      (posting !== null ? parseIsoDate(posting.datePosted) : null),
    fetchedAt,
  });
}

export function createAshbyAdapter(fetchPage: FetchPage): BoardAdapter {
  return {
    vendor: "ashby",
    matchJobUrl: matchAshbyJobUrl,
    matchBoardUrl: matchAshbyBoardUrl,
    async fetchJob(url: string): Promise<Job> {
      const page = await fetchPage(url);
      if (page.status === 404) {
        throw new HireError("job_closed", "Ashby job is gone.");
      }
      if (page.status >= 400) {
        throw new HireError("upstream_blocked", `Ashby returned HTTP ${page.status}.`);
      }
      return parseAshbyJobHtml(page.body, page.url, new Date().toISOString());
    },
    async fetchBoard(_url: string): Promise<JobSummary[]> {
      throw new HireError("internal", "Board list is not implemented in this PR.");
    },
  };
}
