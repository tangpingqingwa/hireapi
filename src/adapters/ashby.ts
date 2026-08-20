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

const JOB_HOSTS = new Set(["jobs.ashbyhq.com"]);

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

function extractJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function extractAshbyBootstrap(html: string): Record<string, unknown> | null {
  const next = /<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (next !== null) {
    const rec = extractJsonObject(next[1]);
    if (rec !== null) {
      return rec;
    }
  }
  const appData = /window\.__appData\s*=\s*/i.exec(html);
  if (appData !== null) {
    const start = appData.index + appData[0].length;
    if (html[start] === "{") {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < html.length; i += 1) {
        const ch = html[i];
        if (inString) {
          if (escape) {
            escape = false;
          } else if (ch === "\\") {
            escape = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "{") {
          depth += 1;
        } else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            const rec = extractJsonObject(html.slice(start, i + 1));
            if (rec !== null) {
              return rec;
            }
            break;
          }
        }
      }
    }
  }
  const tagged = /<script\b[^>]*data-ashby=["']job["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (tagged !== null) {
    return extractJsonObject(tagged[1]);
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
    // Live Ashby serves a 200 SPA shell for unknown slugs (no JobPosting).
    throw new HireError("job_closed", "Ashby job is gone.");
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
      if (!matchAshbyJobUrl(page.url)) {
        throw new HireError("job_closed", "Ashby job is gone.");
      }
      return parseAshbyJobHtml(page.body, page.url, new Date().toISOString());
    },
    async fetchBoard(url: string): Promise<JobSummary[]> {
      const page = await fetchPage(url);
      if (page.status === 404) {
        throw new HireError("board_not_found", "Ashby board is gone.");
      }
      if (page.status >= 400) {
        throw new HireError("upstream_blocked", `Ashby returned HTTP ${page.status}.`);
      }
      return parseAshbyBoardHtml(page.body, page.url);
    },
  };
}

function postingListFromBootstrap(data: Record<string, unknown>): Record<string, unknown>[] {
  const direct = data.jobPostings ?? data.jobs ?? data.postings;
  if (Array.isArray(direct)) {
    return direct.map(asRecord).filter((row): row is Record<string, unknown> => row !== null);
  }
  const board = asRecord(data.jobBoard);
  if (board !== null) {
    const nested = board.jobPostings ?? board.jobs ?? board.postings;
    if (Array.isArray(nested)) {
      return nested.map(asRecord).filter((row): row is Record<string, unknown> => row !== null);
    }
  }
  const props = asRecord(data.props);
  const pageProps = props !== null ? asRecord(props.pageProps) : null;
  if (pageProps !== null) {
    return postingListFromBootstrap(pageProps);
  }
  return [];
}

function ashbySlugFromPosting(posting: Record<string, unknown>, fallbackTitle: string): string {
  return (
    asString(posting.idName) ??
    asString(posting.slug) ??
    asString(posting.id) ??
    fallbackTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

function ashbyBoardCompanyName(html: string, boardUrl: string): string {
  return (
    firstMatch(html, [
      /<div\b[^>]*class=["'][^"']*ashby-job-board-heading[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
      /<title\b[^>]*>Jobs at ([\s\S]*?)<\/title>/i,
    ]) ??
    ashbyCompanyFromUrl(boardUrl) ??
    "Ashby"
  );
}

export function parseAshbyBoardHtml(html: string, boardUrl: string): JobSummary[] {
  const companyName = ashbyBoardCompanyName(html, boardUrl);
  const seen = new Set<string>();
  const out: JobSummary[] = [];
  const bootstrap = extractAshbyBootstrap(html);
  const postings = bootstrap !== null ? postingListFromBootstrap(bootstrap) : [];

  const push = (summary: JobSummary | null): void => {
    if (summary === null || seen.has(summary.id)) {
      return;
    }
    seen.add(summary.id);
    out.push(summary);
  };

  for (const posting of postings) {
    const title = asString(posting.title);
    if (title === null) {
      continue;
    }
    const slug = ashbySlugFromPosting(posting, title);
    if (slug === "") {
      continue;
    }
    const apply = resolveHref(boardUrl.endsWith("/") ? boardUrl : `${boardUrl}/`, slug);
    if (apply === null) {
      continue;
    }
    const locationRaw = asString(posting.locationName) ?? asString(posting.location);
    const workplace = asString(posting.workplaceType);
    const remoteFlag =
      posting.isRemote === true || workplace === "Remote"
        ? true
        : posting.isRemote === false
          ? false
          : null;
    push(
      toJobSummary({
        id: makeJobId("ashby", slug),
        title,
        company: { name: companyName, id: null },
        locations: locationRaw !== null ? [parseLocation(locationRaw)] : [],
        remote: inferRemoteFromParts(
          [locationRaw, workplace].filter((part) => part !== null).join(" "),
          "",
          remoteFlag,
        ),
        applyUrl: normalizeUrl(apply) ?? apply,
        closed: false,
      }),
    );
  }

  const company = ashbyCompanyFromUrl(boardUrl);
  if (company !== null) {
    const linkRe = new RegExp(
      `<a\\b[^>]*href=["']([^"']*/${company}/[^"']+)["'][^>]*>([\\s\\S]*?)</a>`,
      "gi",
    );
    let link: RegExpExecArray | null;
    while ((link = linkRe.exec(html)) !== null) {
      const absolute = resolveHref(boardUrl, link[1]);
      if (absolute === null) {
        continue;
      }
      const slug = parseAshbyJobSlug(absolute);
      if (slug === null || slug === company) {
        continue;
      }
      const title = stripTags(link[2]).trim();
      if (title === "") {
        continue;
      }
      push(
        toJobSummary({
          id: makeJobId("ashby", slug),
          title,
          company: { name: companyName, id: null },
          locations: [],
          remote: null,
          applyUrl: normalizeUrl(absolute) ?? absolute,
          closed: false,
        }),
      );
    }
  }

  return out;
}
