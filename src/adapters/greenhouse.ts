import { HireError } from "../core/errors.js";
import type { BoardAdapter, Job, JobSummary } from "../types.js";
import {
  asRecord,
  asString,
  buildJob,
  buildJobSummary,
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

function greenhouseCompanyFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "embed") {
      return parsed.searchParams.get("for");
    }
    return parts[0] ?? null;
  } catch {
    return null;
  }
}

function extractGreenhouseBoardJobs(html: string): unknown[] {
  const scriptRe =
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    try {
      const parsed: unknown = JSON.parse(match[1]);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      const rec = asRecord(parsed);
      if (rec === null) {
        continue;
      }
      if (Array.isArray(rec.jobs)) {
        return rec.jobs;
      }
      if (Array.isArray(rec.itemListElement)) {
        return rec.itemListElement;
      }
    } catch {
      // try next block
    }
  }
  const jobsVar = /window\.GreenhouseJobs\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html);
  if (jobsVar !== null) {
    try {
      const parsed: unknown = JSON.parse(jobsVar[1]);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // fall through to HTML rows
    }
  }
  return [];
}

function applyUrlFromBoardItem(item: Record<string, unknown>, boardUrl: string): string | null {
  const direct =
    asString(item.absolute_url) ??
    asString(item.url) ??
    asString(item.hostedUrl) ??
    asString(item.applyUrl);
  if (direct !== null) {
    return normalizeUrl(direct) ?? direct;
  }
  const id = asString(item.id) ?? asString(item.jobId);
  if (id === null || !/^\d+$/.test(id)) {
    return null;
  }
  const company = greenhouseCompanyFromUrl(boardUrl);
  if (company === null) {
    return null;
  }
  return `https://boards.greenhouse.io/${company}/jobs/${id}`;
}

export function parseGreenhouseBoardHtml(html: string, boardUrl: string): JobSummary[] {
  const company =
    firstMatch(html, [
      /<h1\b[^>]*class=["'][^"']*company-name[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i,
      /<span\b[^>]*class=["'][^"']*company-name[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    ]) ??
    greenhouseCompanyFromUrl(boardUrl) ??
    "Unknown";
  const summaries: JobSummary[] = [];
  const seen = new Set<string>();

  for (const raw of extractGreenhouseBoardJobs(html)) {
    const rec = asRecord(raw);
    if (rec === null) {
      continue;
    }
    const item = asRecord(rec.item) ?? rec;
    const applyUrl = applyUrlFromBoardItem(item, boardUrl);
    const sourceJobId = applyUrl !== null ? parseGreenhouseJobId(applyUrl) : null;
    const title = asString(item.title);
    if (applyUrl === null || sourceJobId === null || title === null) {
      continue;
    }
    if (seen.has(applyUrl)) {
      continue;
    }
    seen.add(applyUrl);
    const locationRaw =
      asString(item.location) ??
      asString(asRecord(item.location)?.name) ??
      null;
    const locations = locationRaw !== null ? [parseLocation(locationRaw)] : [];
    summaries.push(
      buildJobSummary({
        source: "greenhouse",
        sourceJobId,
        title,
        companyName: company.replace(/^at\s+/i, ""),
        locations,
        remote: inferRemoteFromParts(locationRaw, title, null),
        applyUrl,
      }),
    );
  }

  const rowRe =
    /<div\b[^>]*class=["'][^"']*opening[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<span\b[^>]*class=["'][^"']*location[^"']*["'][^>]*>([\s\S]*?)<\/span>)?/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html)) !== null) {
    const href = row[1];
    const applyUrl = normalizeUrl(new URL(href, boardUrl).toString()) ?? href;
    const sourceJobId = parseGreenhouseJobId(applyUrl);
    const title = stripTags(row[2] ?? "");
    if (sourceJobId === null || title === "") {
      continue;
    }
    if (seen.has(applyUrl)) {
      continue;
    }
    seen.add(applyUrl);
    const locationRaw = row[3] !== undefined ? stripTags(row[3]) : null;
    const locations = locationRaw !== null && locationRaw !== "" ? [parseLocation(locationRaw)] : [];
    summaries.push(
      buildJobSummary({
        source: "greenhouse",
        sourceJobId,
        title,
        companyName: company.replace(/^at\s+/i, ""),
        locations,
        remote: inferRemoteFromParts(locationRaw, title, null),
        applyUrl,
      }),
    );
  }

  return summaries;
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
    async fetchBoard(url: string): Promise<JobSummary[]> {
      const page = await fetchPage(url);
      if (page.status === 404) {
        throw new HireError("board_not_found", "Greenhouse board is gone.");
      }
      if (page.status >= 400) {
        throw new HireError("upstream_blocked", `Greenhouse returned HTTP ${page.status}.`);
      }
      return parseGreenhouseBoardHtml(page.body, page.url);
    },
  };
}
