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

const JOB_HOSTS = new Set(["jobs.lever.co"]);

export function matchLeverJobUrl(url: string): boolean {
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
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    return false;
  }
  if (parts[0] === "embed" || parts[0] === "api") {
    return false;
  }
  if (parts.length === 2 && parts[1].toLowerCase() === "apply") {
    return false;
  }
  return true;
}

export function matchLeverBoardUrl(url: string): boolean {
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
  const parts = parsed.pathname.split("/").filter(Boolean);
  return parts.length === 1 && parts[0] !== "embed" && parts[0] !== "api";
}

export function parseLeverJobId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    if (parts[parts.length - 1].toLowerCase() === "apply" && parts.length >= 3) {
      return parts[parts.length - 2];
    }
    return parts[1];
  } catch {
    return null;
  }
}

export function parseLeverCompany(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[0] ?? null;
  } catch {
    return null;
  }
}

export function canonicalLeverJobUrl(url: string): string {
  const normalized = normalizeUrl(url) ?? url;
  return normalized.replace(/\/apply$/i, "");
}

export function parseLeverJobHtml(html: string, url: string, fetchedAt: string): Job {
  const sourceJobId = parseLeverJobId(url);
  if (sourceJobId === null) {
    throw new HireError("invalid_request", "Lever job URL is missing a posting id.");
  }
  const posting = extractJsonLdJobPosting(html);
  const title =
    firstMatch(html, [
      /<div\b[^>]*class=["'][^"']*posting-headline[^"']*["'][^>]*>[\s\S]*?<h2\b[^>]*>([\s\S]*?)<\/h2>/i,
      /<div\b[^>]*class=["'][^"']*posting-header[^"']*["'][^>]*>[\s\S]*?<h2\b[^>]*>([\s\S]*?)<\/h2>/i,
      /<h2\b[^>]*>([\s\S]*?)<\/h2>/i,
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
    ]) ?? (typeof posting?.title === "string" ? posting.title : null);
  if (title === null || title === "") {
    throw new HireError("internal", "Lever job page is missing a title.");
  }
  const companyRaw =
    firstMatch(html, [
      /<div\b[^>]*class=["'][^"']*main-header-text[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      /<a\b[^>]*class=["'][^"']*main-header-logo[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*alt=["']([^"']+)["']/i,
      /<img\b[^>]*class=["'][^"']*[^"']*logo[^"']*["'][^>]*alt=["']([^"']+)["']/i,
    ]) ??
    organizationName(posting?.hiringOrganization) ??
    parseLeverCompany(url);
  const company = companyRaw?.replace(/\s+logo$/i, "").trim() ?? null;
  if (company === null || company === "") {
    throw new HireError("internal", "Lever job page is missing a company.");
  }
  const locationRaw = firstMatch(html, [
    /<(?:div|span)\b[^>]*class=["'][^"']*sort-by-location[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i,
    /<(?:div|span)\b[^>]*class=["'][^"']*sort-by-time[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i,
  ]);
  const workplace = firstMatch(html, [
    /<(?:div|span)\b[^>]*class=["'][^"']*(?:sort-by-workplace|workplaceTypes)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i,
  ]);
  const commitment = firstMatch(html, [
    /<(?:div|span)\b[^>]*class=["'][^"']*sort-by-commitment[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i,
  ]);
  const locations =
    locationRaw !== null
      ? [parseLocation(locationRaw)]
      : posting !== null
        ? locationsFromJsonLd(posting)
        : [];
  const descriptionHtml =
    innerHtml(html, { className: "posting-page" }) ??
    innerHtml(html, { className: "content" }) ??
    (typeof posting?.description === "string" ? posting.description : "");
  const salary =
    findSalaryInText(stripTags(descriptionHtml)) ??
    (posting !== null ? salaryFromJsonLd(posting) : null);
  const applyUrl = canonicalLeverJobUrl(url);
  const remote = inferRemoteFromParts(
    [locationRaw, workplace].filter((part) => part !== null).join(" "),
    stripTags(descriptionHtml),
    posting !== null ? remoteFromJsonLd(posting) : null,
  );
  return buildJob({
    source: "lever",
    sourceJobId,
    title,
    companyName: company,
    locations,
    remote,
    employmentType:
      parseEmploymentType(commitment) ??
      (posting !== null ? parseEmploymentType(posting.employmentType) : null),
    salary,
    descriptionHtml,
    applyUrl,
    postedAt: posting !== null ? parseIsoDate(posting.datePosted) : null,
    fetchedAt,
  });
}

export function createLeverAdapter(fetchPage: FetchPage): BoardAdapter {
  return {
    vendor: "lever",
    matchJobUrl: matchLeverJobUrl,
    matchBoardUrl: matchLeverBoardUrl,
    async fetchJob(url: string): Promise<Job> {
      const page = await fetchPage(url);
      if (page.status === 404) {
        throw new HireError("job_closed", "Lever job is gone.");
      }
      if (page.status >= 400) {
        throw new HireError("upstream_blocked", `Lever returned HTTP ${page.status}.`);
      }
      return parseLeverJobHtml(page.body, page.url, new Date().toISOString());
    },
    async fetchBoard(url: string): Promise<JobSummary[]> {
      const page = await fetchPage(url);
      if (page.status === 404) {
        throw new HireError("board_not_found", "Lever board is gone.");
      }
      if (page.status >= 400) {
        throw new HireError("upstream_blocked", `Lever returned HTTP ${page.status}.`);
      }
      return parseLeverBoardHtml(page.body, page.url);
    },
  };
}

function leverBoardCompanyName(html: string, boardUrl: string): string {
  return (
    firstMatch(html, [
      /<div\b[^>]*class=["'][^"']*main-header-text[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      /<a\b[^>]*class=["'][^"']*main-header-logo[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*alt=["']([^"']+)["']/i,
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
      /<title\b[^>]*>Jobs at ([\s\S]*?)<\/title>/i,
    ]) ??
    parseLeverCompany(boardUrl) ??
    "Lever"
  );
}

function locationNearPosting(block: string): string | null {
  return firstMatch(block, [
    /<(?:div|span)\b[^>]*class=["'][^"']*sort-by-location[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i,
    /<(?:div|span)\b[^>]*class=["'][^"']*sort-by-time[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i,
    /<(?:div|span)\b[^>]*class=["'][^"']*(?:sort-by-workplace|workplaceTypes)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i,
  ]);
}

function workplaceNearPosting(block: string): string | null {
  return firstMatch(block, [
    /<(?:div|span)\b[^>]*class=["'][^"']*(?:sort-by-workplace|workplaceTypes)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i,
  ]);
}

function titleFromPostingLink(titleHtml: string): string {
  return (
    firstMatch(titleHtml, [
      /<h5\b[^>]*>([\s\S]*?)<\/h5>/i,
      /<h2\b[^>]*>([\s\S]*?)<\/h2>/i,
      /<h3\b[^>]*>([\s\S]*?)<\/h3>/i,
    ]) ?? stripTags(titleHtml).trim()
  );
}

function summaryFromLeverLink(
  href: string,
  titleHtml: string,
  locationRaw: string | null,
  workplace: string | null,
  companyName: string,
  boardUrl: string,
): JobSummary | null {
  const absolute = resolveHref(boardUrl, href);
  if (absolute === null || !matchLeverJobUrl(absolute)) {
    return null;
  }
  const sourceJobId = parseLeverJobId(absolute);
  if (sourceJobId === null) {
    return null;
  }
  const title = titleFromPostingLink(titleHtml);
  if (title === "" || /^apply$/i.test(title)) {
    return null;
  }
  const applyUrl = canonicalLeverJobUrl(absolute);
  return toJobSummary({
    id: makeJobId("lever", sourceJobId),
    title,
    company: { name: companyName, id: null },
    locations: locationRaw !== null && locationRaw !== "" ? [parseLocation(locationRaw)] : [],
    remote: inferRemoteFromParts(
      [locationRaw, workplace].filter((part) => part !== null).join(" "),
      "",
      null,
    ),
    applyUrl,
    closed: false,
  });
}

export function parseLeverBoardHtml(html: string, boardUrl: string): JobSummary[] {
  const companyName = leverBoardCompanyName(html, boardUrl);
  const seen = new Set<string>();
  const out: JobSummary[] = [];

  const push = (summary: JobSummary | null): void => {
    if (summary === null || seen.has(summary.id)) {
      return;
    }
    seen.add(summary.id);
    out.push(summary);
  };

  const blockRe = /<div\b[^>]*class=["'][^"']*\bposting\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) !== null) {
    const link =
      /<a\b[^>]*class=["'][^"']*posting-title[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(
        block[1],
      ) ??
      /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*posting-title[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(
        block[1],
      ) ??
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block[1]);
    if (link === null) {
      continue;
    }
    push(
      summaryFromLeverLink(
        link[1],
        link[2],
        locationNearPosting(block[1]),
        workplaceNearPosting(block[1]),
        companyName,
        boardUrl,
      ),
    );
  }

  const linkRe =
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let link: RegExpExecArray | null;
  while ((link = linkRe.exec(html)) !== null) {
    const absolute = resolveHref(boardUrl, link[1]);
    if (absolute === null || !matchLeverJobUrl(absolute)) {
      continue;
    }
    const windowStart = Math.max(0, link.index - 200);
    const windowEnd = Math.min(html.length, link.index + link[0].length + 400);
    const around = html.slice(windowStart, windowEnd);
    push(
      summaryFromLeverLink(
        link[1],
        link[2],
        locationNearPosting(around),
        workplaceNearPosting(around),
        companyName,
        boardUrl,
      ),
    );
  }

  return out;
}
