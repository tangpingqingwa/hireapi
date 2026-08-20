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
  makeJobId,
  normalizeUrl,
  organizationName,
  parseEmploymentType,
  parseIsoDate,
  parseLocation,
  remoteFromJsonLd,
  resolveHref,
  salaryFromJsonLd,
  stripTags,
  toJobSummary,
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
  if (/\/jobs\/\d+/.test(url) || /\/embed\/job_app/.test(url)) {
    return false;
  }
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  return parts.length >= 1 && parts[0] !== "embed";
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
      /<title\b[^>]*>[\s\S]*?\s+at\s+([^<]+?)\s*<\/title>/i,
    ]) ??
    organizationName(posting?.hiringOrganization) ??
    greenhouseBoardToken(url);
  if (company === null || company === "") {
    throw new HireError("internal", "Greenhouse job page is missing a company.");
  }
  const locationRaw = firstMatch(html, [
    /<div\b[^>]*class=["'][^"']*job__location[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
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
    innerHtml(html, { className: "job__description" }) ??
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
      // Live GH 404s often 302 to the board (`?error=true`) instead of HTTP 404.
      if (!matchGreenhouseJobUrl(page.url)) {
        throw new HireError("job_closed", "Greenhouse job is gone.");
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

export function greenhouseBoardToken(url: string): string | null {
  try {
    const parsed = new URL(url);
    const forToken = parsed.searchParams.get("for");
    if (forToken !== null && forToken !== "") {
      return forToken;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== undefined && parts[0] !== "embed" && parts[0] !== "jobs") {
      return parts[0];
    }
    return null;
  } catch {
    return null;
  }
}

function greenhouseCompanyName(html: string, boardUrl: string): string {
  const fromPage =
    firstMatch(html, [
      /<span\b[^>]*class=["'][^"']*company-name[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
      /<title\b[^>]*>Jobs at ([\s\S]*?)<\/title>/i,
      /<title\b[^>]*>([\s\S]*?)<\/title>/i,
    ]);
  if (fromPage !== null && fromPage !== "") {
    return fromPage
      .replace(/^current openings at\s+/i, "")
      .replace(/^jobs at\s+/i, "")
      .replace(/^at\s+/i, "")
      .replace(/\s+jobs$/i, "")
      .trim();
  }
  return greenhouseBoardToken(boardUrl) ?? "Greenhouse";
}

function locationNearLink(block: string): string | null {
  return firstMatch(block, [
    /<span\b[^>]*class=["'][^"']*location[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    /<div\b[^>]*class=["'][^"']*location[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<p\b[^>]*class=["'][^"']*[^"']*metadata[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
  ]);
}

function summaryFromGreenhouseLink(
  href: string,
  titleHtml: string,
  locationRaw: string | null,
  companyName: string,
  boardUrl: string,
): JobSummary | null {
  const absolute = resolveHref(boardUrl, href);
  if (absolute === null || !/\/jobs\/\d+/.test(absolute)) {
    return null;
  }
  const sourceJobId = parseGreenhouseJobId(absolute);
  if (sourceJobId === null) {
    return null;
  }
  const title =
    firstMatch(titleHtml, [
      /<p\b[^>]*class=["'][^"']*body--medium[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
    ]) ?? stripTags(titleHtml).trim();
  if (title === "") {
    return null;
  }
  const locationFromLink = firstMatch(titleHtml, [
    /<p\b[^>]*class=["'][^"']*body--metadata[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    /<div\b[^>]*class=["'][^"']*job__location[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ]);
  const location = locationRaw ?? locationFromLink;
  const applyUrl = normalizeUrl(absolute) ?? absolute;
  return toJobSummary({
    id: makeJobId("greenhouse", sourceJobId),
    title,
    company: { name: companyName, id: null },
    locations: location !== null && location !== "" ? [parseLocation(location)] : [],
    remote: inferRemoteFromParts(location, "", null),
    applyUrl,
    closed: false,
  });
}

export function parseGreenhouseBoardHtml(html: string, boardUrl: string): JobSummary[] {
  const companyName = greenhouseCompanyName(html, boardUrl);
  const seen = new Set<string>();
  const out: JobSummary[] = [];

  const push = (summary: JobSummary | null): void => {
    if (summary === null || seen.has(summary.id)) {
      return;
    }
    seen.add(summary.id);
    out.push(summary);
  };

  const blockRe =
    /<(?:div|tr)\b[^>]*class=["'][^"']*\b(?:opening|job-post)\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|tr)>/gi;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) !== null) {
    const link = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block[1]);
    if (link === null) {
      continue;
    }
    push(
      summaryFromGreenhouseLink(link[1], link[2], locationNearLink(block[1]), companyName, boardUrl),
    );
  }

  const linkRe = /<a\b[^>]*href=["']([^"']*\/jobs\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let link: RegExpExecArray | null;
  while ((link = linkRe.exec(html)) !== null) {
    const windowStart = Math.max(0, link.index - 200);
    const windowEnd = Math.min(html.length, link.index + link[0].length + 400);
    push(
      summaryFromGreenhouseLink(
        link[1],
        link[2],
        locationNearLink(html.slice(windowStart, windowEnd)),
        companyName,
        boardUrl,
      ),
    );
  }

  return out;
}
