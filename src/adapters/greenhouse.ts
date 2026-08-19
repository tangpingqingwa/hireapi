import { HireError } from "../core/errors.js";
import type { BoardAdapter, Job, JobSummary } from "../types.js";
import {
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

const JOB_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io"]);

export function matchGreenhouseJobUrl(url: string): boolean {
  const host = hostOf(url);
  if (host === null || !JOB_HOSTS.has(host)) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const path = parsed.pathname;
  const token = parsed.searchParams.get("token") ?? "";
  if (/\/embed\/job_app\/?$/.test(path) && /^\d+$/.test(token)) {
    return true;
  }
  return /\/jobs\/\d+/.test(path);
}

export function matchGreenhouseBoardUrl(url: string): boolean {
  const host = hostOf(url);
  if (host === null || !JOB_HOSTS.has(host)) {
    return false;
  }
  if (/\/jobs\/\d+/.test(url)) {
    return false;
  }
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  return parts.length >= 1;
}

export function parseGreenhouseJobId(url: string): string | null {
  const jobs = /\/jobs\/(\d+)/.exec(url);
  if (jobs) {
    return jobs[1];
  }
  const token = /[?&]token=(\d+)/.exec(url);
  return token?.[1] ?? null;
}

export function parseGreenhouseJobHtml(html: string, url: string, fetchedAt: string): Job {
  const sourceJobId = parseGreenhouseJobId(url);
  if (sourceJobId === null) {
    throw new HireError("invalid_request", "Greenhouse job URL is missing a numeric id.");
  }
  const posting = extractJsonLdJobPosting(html);
  const title =
    firstMatch(html, [
      /<h1\b[^>]*class=["'][^"']*app-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i,
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
    ]) ??
    (typeof posting?.title === "string" ? posting.title : null);
  if (title === null || title === "") {
    throw new HireError("internal", "Greenhouse job page is missing a title.");
  }
  const company =
    firstMatch(html, [
      /<span\b[^>]*class=["'][^"']*company-name[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
      /<div\b[^>]*class=["'][^"']*company-name[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    ]) ??
    organizationName(posting?.hiringOrganization);
  if (company === null || company === "") {
    throw new HireError("internal", "Greenhouse job page is missing a company.");
  }
  const locationRaw = firstMatch(html, [
    /<div\b[^>]*class=["'][^"']*location[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<span\b[^>]*class=["'][^"']*location[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
  ]);
  const locations =
    locationRaw !== null
      ? [parseLocation(locationRaw)]
      : posting !== null
        ? locationsFromJsonLd(posting)
        : [];
  const descriptionHtml =
    innerHtml(html, { id: "content" }) ??
    innerHtml(html, { className: "content" }) ??
    (typeof posting?.description === "string" ? posting.description : "");
  const salary =
    findSalaryInText(stripTags(descriptionHtml)) ??
    (locationRaw !== null ? findSalaryInText(locationRaw) : null) ??
    (posting !== null ? salaryFromJsonLd(posting) : null);
  const applyUrl = normalizeUrl(url) ?? url;
  const remote = inferRemoteFromParts(
    locationRaw,
    stripTags(descriptionHtml),
    posting !== null ? remoteFromJsonLd(posting) : null,
  );
  return buildJob({
    source: "greenhouse",
    sourceJobId,
    title,
    companyName: company.replace(/^at\s+/i, ""),
    locations,
    remote,
    employmentType: posting !== null ? parseEmploymentType(posting.employmentType) : null,
    salary,
    descriptionHtml,
    applyUrl,
    postedAt: posting !== null ? parseIsoDate(posting.datePosted) : null,
    fetchedAt,
  });
}

export function createGreenhouseAdapter(fetchPage: FetchPage): BoardAdapter {
  return {
    vendor: "greenhouse",
    matchJobUrl: matchGreenhouseJobUrl,
    matchBoardUrl: matchGreenhouseBoardUrl,
    async fetchJob(url: string): Promise<Job> {
      const page = await fetchPage(url);
      if (page.status === 404) {
        throw new HireError("job_closed", "Greenhouse job is gone.");
      }
      if (page.status >= 400) {
        throw new HireError("upstream_blocked", `Greenhouse returned HTTP ${page.status}.`);
      }
      return parseGreenhouseJobHtml(page.body, page.url, new Date().toISOString());
    },
    async fetchBoard(_url: string): Promise<JobSummary[]> {
      throw new HireError("internal", "Board list is not implemented in this PR.");
    },
  };
}
