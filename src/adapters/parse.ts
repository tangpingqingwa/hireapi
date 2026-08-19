import { toMarkdown } from "../markdown.js";
import type {
  AdapterVendor,
  EmploymentType,
  Job,
  JobLocation,
  JobSummary,
  Salary,
  SalaryPeriod,
  Source,
} from "../types.js";

const US_STATES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC",
]);

const COUNTRY_ALIASES: Record<string, string> = {
  us: "US",
  usa: "US",
  "united states": "US",
  "united states of america": "US",
  uk: "GB",
  "united kingdom": "GB",
  "great britain": "GB",
  england: "GB",
  gb: "GB",
  ca: "CA",
  canada: "CA",
  de: "DE",
  germany: "DE",
  fr: "FR",
  france: "FR",
  nl: "NL",
  netherlands: "NL",
  ie: "IE",
  ireland: "IE",
  au: "AU",
  australia: "AU",
  in: "IN",
  india: "IN",
  jp: "JP",
  japan: "JP",
  sg: "SG",
  singapore: "SG",
};

export function safeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function normalizeUrl(raw: string): string | null {
  const url = safeUrl(raw);
  if (url === null) {
    return null;
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

export function hostOf(raw: string): string | null {
  return safeUrl(raw)?.hostname.toLowerCase().replace(/^www\./, "") ?? null;
}

export function makeJobId(source: Source, sourceJobId: string): string {
  const slug = sourceJobId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `job_${source}_${slug}`;
}

export function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

export function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function extractJsonLdObjects(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    try {
      const parsed: unknown = JSON.parse(match[1]);
      flattenJsonLd(parsed, out);
    } catch {
      // ignore malformed blocks
    }
  }
  return out;
}

function flattenJsonLd(value: unknown, out: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      flattenJsonLd(item, out);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  if (record["@graph"] !== undefined) {
    flattenJsonLd(record["@graph"], out);
  }
  out.push(value);
}

export type JsonLdJobPosting = {
  title?: unknown;
  description?: unknown;
  datePosted?: unknown;
  employmentType?: unknown;
  hiringOrganization?: unknown;
  jobLocation?: unknown;
  jobLocationType?: unknown;
  applicantLocationRequirements?: unknown;
  baseSalary?: unknown;
  identifier?: unknown;
  url?: unknown;
};

export function extractJsonLdJobPosting(html: string): JsonLdJobPosting | null {
  for (const obj of extractJsonLdObjects(html)) {
    if (obj === null || typeof obj !== "object") {
      continue;
    }
    const record = obj as Record<string, unknown>;
    const type = record["@type"];
    const types = Array.isArray(type) ? type.map(String) : [String(type ?? "")];
    if (types.includes("JobPosting")) {
      return record as JsonLdJobPosting;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

export function organizationName(value: unknown): string | null {
  const direct = asString(value);
  if (direct !== null) {
    return direct;
  }
  const rec = asRecord(value);
  if (rec === null) {
    return null;
  }
  return asString(rec.name);
}

export function parseEmploymentType(value: unknown): EmploymentType | null {
  const chunks = Array.isArray(value) ? value : [value];
  const text = chunks
    .map((item) => asString(item) ?? "")
    .join(" ")
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  if (text === "") {
    return null;
  }
  if (/\bintern(ship)?\b/.test(text)) {
    return "intern";
  }
  if (/\bpart\s*time\b/.test(text)) {
    return "part_time";
  }
  if (/\b(contract|contractor|temporary|temp)\b/.test(text)) {
    return "contract";
  }
  if (/\bfull\s*time\b/.test(text)) {
    return "full_time";
  }
  if (/\b(other|volunteer|seasonal)\b/.test(text)) {
    return "other";
  }
  return null;
}

export function parseLocation(raw: string): JobLocation {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  const withoutRemote = cleaned
    .replace(/\s*[·|]\s*/g, ", ")
    .replace(/\b(remote|hybrid|on-?site)\b/gi, "")
    .replace(/(^[,\s]+)|([,\s]+$)/g, "")
    .replace(/\s*,\s*,/g, ",")
    .trim();
  if (withoutRemote === "" || /^remote$/i.test(cleaned)) {
    return { raw: cleaned, city: null, region: null, country: null };
  }
  const parts = withoutRemote
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  let city: string | null = parts[0] ?? null;
  let region: string | null = null;
  let country: string | null = null;
  if (parts.length === 2) {
    const second = parts[1];
    const upper = second.toUpperCase();
    if (US_STATES.has(upper)) {
      region = upper;
      country = "US";
    } else {
      country = COUNTRY_ALIASES[second.toLowerCase()] ?? second;
    }
  } else if (parts.length >= 3) {
    city = parts[0];
    const mid = parts[1];
    const last = parts[parts.length - 1];
    region = US_STATES.has(mid.toUpperCase()) ? mid.toUpperCase() : mid;
    country = COUNTRY_ALIASES[last.toLowerCase()] ?? last;
  }
  if (city !== null && /^(remote|anywhere)$/i.test(city)) {
    city = null;
  }
  return { raw: cleaned, city, region, country };
}

export function locationsFromJsonLd(posting: JsonLdJobPosting): JobLocation[] {
  const nodes = Array.isArray(posting.jobLocation)
    ? posting.jobLocation
    : posting.jobLocation === undefined
      ? []
      : [posting.jobLocation];
  const out: JobLocation[] = [];
  for (const node of nodes) {
    const rec = asRecord(node);
    if (rec === null) {
      const raw = asString(node);
      if (raw !== null) {
        out.push(parseLocation(raw));
      }
      continue;
    }
    const address = asRecord(rec.address) ?? rec;
    const city = asString(address.addressLocality);
    const region = asString(address.addressRegion);
    const countryRaw = asString(address.addressCountry);
    const country =
      countryRaw === null ? null : (COUNTRY_ALIASES[countryRaw.toLowerCase()] ?? countryRaw);
    const name = asString(rec.name);
    const raw =
      [city, region, country].filter((part) => part !== null).join(", ") || name || "Unknown";
    out.push({
      raw,
      city,
      region: region !== null && US_STATES.has(region.toUpperCase()) ? region.toUpperCase() : region,
      country,
    });
  }
  return out;
}

export function inferRemote(text: string): boolean | null {
  const t = text.toLowerCase();
  const remote = /\b(remote|work from home|wfh|distributed|telecommute|anywhere)\b/.test(t);
  const onsite = /\b(on-?site|in-office|office-based)\b/.test(t);
  const hybrid = /\bhybrid\b/.test(t);
  if (remote && !onsite) {
    return true;
  }
  if (onsite && !remote) {
    return false;
  }
  if (hybrid && !remote) {
    return null;
  }
  return null;
}

export function inferRemoteFromParts(
  locationRaw: string | null,
  description: string,
  jsonLdRemote: boolean | null,
): boolean | null {
  const text = `${locationRaw ?? ""} ${description}`;
  const fromText = inferRemote(text);
  if (fromText !== null) {
    return fromText;
  }
  if (jsonLdRemote !== null) {
    return jsonLdRemote;
  }
  if (locationRaw !== null && parseLocation(locationRaw).city !== null) {
    return false;
  }
  return null;
}

export function remoteFromJsonLd(posting: JsonLdJobPosting): boolean | null {
  const type = asString(posting.jobLocationType);
  if (type !== null && /telecommute/i.test(type)) {
    return true;
  }
  return null;
}

const PERIOD_RE =
  /\b(?:an?|per|\/)\s*(year|yr|annum|annual|annually|hour|hr|month|mo)\b|\b(yearly|hourly|monthly)\b/i;

const SALARY_AMOUNT = String.raw`(?:[$£€]|usd|gbp|eur)\s*\d[\d,]*(?:\.\d+)?k?`;
const SALARY_RANGE_TAIL = String.raw`(?:\s*(?:–|—|-|to)\s*(?:[$£€]|usd|gbp|eur)?\s*\d[\d,]*(?:\.\d+)?k?)?`;
const SALARY_PERIOD_TAIL = String.raw`\s*(?:(?:an?|per|\/)\s*(?:year|yr|annum|annual|annually|hour|hr|month|mo)|yearly|hourly|monthly)\b`;
const SALARY_SNIPPET = new RegExp(`${SALARY_AMOUNT}${SALARY_RANGE_TAIL}${SALARY_PERIOD_TAIL}`, "i");

function periodFromText(text: string): SalaryPeriod | null {
  const match = PERIOD_RE.exec(text);
  if (match === null) {
    return null;
  }
  const token = (match[1] ?? match[2] ?? "").toLowerCase();
  if (token.startsWith("year") || token === "yr" || token === "annum" || token === "annual") {
    return "year";
  }
  if (token.startsWith("hour") || token === "hr") {
    return "hour";
  }
  if (token.startsWith("month") || token === "mo") {
    return "month";
  }
  return null;
}

function currencyFromText(text: string): string | null {
  if (/\$|usd\b/i.test(text)) {
    return "USD";
  }
  if (/£|gbp\b/i.test(text)) {
    return "GBP";
  }
  if (/€|eur\b/i.test(text)) {
    return "EUR";
  }
  return null;
}

function parseMoneyToken(raw: string): number | null {
  const cleaned = raw.replace(/[$,£€\s]/g, "");
  const k = /k$/i.test(cleaned);
  const num = Number.parseFloat(cleaned.replace(/k$/i, ""));
  if (!Number.isFinite(num)) {
    return null;
  }
  const value = k ? num * 1000 : num;
  if (value < 0) {
    return null;
  }
  return Math.round(value);
}

/**
 * Only explicit ranges or singles with a period attached to the amount.
 * A period word elsewhere in the blob ("Hourly contractors… $160,000 a year")
 * does not count. "competitive", "$100k+", or a bare number → null.
 */
export function parseSalary(text: string): Salary | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized === "") {
    return null;
  }
  const snippetMatch = SALARY_SNIPPET.exec(normalized);
  if (snippetMatch === null) {
    return null;
  }
  const raw = snippetMatch[0];
  const period = periodFromText(raw);
  if (period === null) {
    return null;
  }
  const currency = currencyFromText(raw);
  if (currency === null) {
    return null;
  }
  const range = raw.match(
    /([$£€]|usd|gbp|eur)?\s*(\d[\d,]*(?:\.\d+)?k?)\s*(?:–|—|-|to)\s*([$£€]|usd|gbp|eur)?\s*(\d[\d,]*(?:\.\d+)?k?)/i,
  );
  if (range) {
    const min = parseMoneyToken(range[2]);
    const max = parseMoneyToken(range[4]);
    if (min === null || max === null || min > max) {
      return null;
    }
    return { min, max, currency, period, raw };
  }
  const single = raw.match(/([$£€]|usd|gbp|eur)\s*(\d[\d,]*(?:\.\d+)?k?)/i);
  if (single) {
    const amount = parseMoneyToken(single[2]);
    if (amount === null) {
      return null;
    }
    return { min: amount, max: amount, currency, period, raw };
  }
  return null;
}

export function salaryFromJsonLd(posting: JsonLdJobPosting): Salary | null {
  const rec = asRecord(posting.baseSalary);
  if (rec === null) {
    return null;
  }
  const currency = asString(rec.currency);
  const value = asRecord(rec.value) ?? rec;
  const min =
    typeof value.minValue === "number"
      ? value.minValue
      : Number.parseFloat(asString(value.minValue) ?? "");
  const max =
    typeof value.maxValue === "number"
      ? value.maxValue
      : Number.parseFloat(asString(value.maxValue) ?? "");
  const one =
    typeof value.value === "number"
      ? value.value
      : Number.parseFloat(asString(value.value) ?? "");
  const unit = (asString(value.unitText) ?? asString(rec.unitText) ?? "").toLowerCase();
  let period: SalaryPeriod | null = null;
  if (/year|annum|annual/.test(unit)) {
    period = "year";
  } else if (/hour/.test(unit)) {
    period = "hour";
  } else if (/month/.test(unit)) {
    period = "month";
  }
  if (period === null || currency === null) {
    return null;
  }
  const lo = Number.isFinite(min) ? min : Number.isFinite(one) ? one : null;
  const hi = Number.isFinite(max) ? max : Number.isFinite(one) ? one : null;
  if (lo === null && hi === null) {
    return null;
  }
  const rawParts = [
    currency,
    lo !== null ? String(lo) : null,
    hi !== null && hi !== lo ? `–${hi}` : null,
    period,
  ].filter((part) => part !== null);
  return {
    min: lo,
    max: hi,
    currency,
    period,
    raw: rawParts.join(" "),
  };
}

export function findSalaryInText(text: string): Salary | null {
  return parseSalary(text);
}

export function firstMatch(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    const value = match?.[1]?.trim();
    if (value) {
      return decodeHtmlEntities(stripTags(value));
    }
  }
  return null;
}

function attrMatches(openTag: string, attr: "id" | "class", value: string): boolean {
  const re =
    attr === "id"
      ? /\bid=["']([^"']+)["']/i
      : /\bclass=["']([^"']+)["']/i;
  const match = re.exec(openTag);
  if (match === null) {
    return false;
  }
  if (attr === "id") {
    return match[1] === value;
  }
  return match[1].split(/\s+/).includes(value);
}

export function innerHtml(html: string, idOrClass: { id?: string; className?: string }): string | null {
  const tokenRe = /<\/?([a-zA-Z][\w:-]*)\b[^>]*\/?>/g;
  let token: RegExpExecArray | null;
  while ((token = tokenRe.exec(html)) !== null) {
    const raw = token[0];
    if (raw.startsWith("</") || raw.endsWith("/>")) {
      continue;
    }
    const tag = token[1].toLowerCase();
    const hit =
      (idOrClass.id !== undefined && attrMatches(raw, "id", idOrClass.id)) ||
      (idOrClass.className !== undefined && attrMatches(raw, "class", idOrClass.className));
    if (!hit) {
      continue;
    }
    const start = token.index + raw.length;
    let depth = 1;
    const innerRe = new RegExp(`<\\/?${tag}\\b[^>]*\\/?>`, "gi");
    innerRe.lastIndex = start;
    let inner: RegExpExecArray | null;
    while ((inner = innerRe.exec(html)) !== null) {
      if (inner[0].startsWith("</")) {
        depth -= 1;
        if (depth === 0) {
          return html.slice(start, inner.index);
        }
      } else if (!inner[0].endsWith("/>")) {
        depth += 1;
      }
    }
    return html.slice(start);
  }
  return null;
}

export function buildJob(input: {
  source: AdapterVendor;
  sourceJobId: string;
  title: string;
  companyName: string;
  locations: JobLocation[];
  remote: boolean | null;
  employmentType: EmploymentType | null;
  salary: Salary | null;
  descriptionHtml: string;
  applyUrl: string;
  postedAt: string | null;
  fetchedAt: string;
}): Job {
  return {
    id: makeJobId(input.source, input.sourceJobId),
    source: input.source,
    sourceJobId: input.sourceJobId,
    title: input.title.trim(),
    company: { name: input.companyName.trim(), id: null },
    locations: input.locations.length > 0 ? input.locations : [],
    remote: input.remote,
    employmentType: input.employmentType,
    salary: input.salary,
    descriptionMarkdown: toMarkdown(input.descriptionHtml),
    applyUrl: input.applyUrl,
    postedAt: input.postedAt,
    closed: false,
    closedAt: null,
    fetchedAt: input.fetchedAt,
  };
}

export function toJobSummary(job: {
  id: string;
  title: string;
  company: Job["company"];
  locations: JobLocation[];
  remote: boolean | null;
  applyUrl: string;
  closed: boolean;
}): JobSummary {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    locations: job.locations,
    remote: job.remote,
    applyUrl: job.applyUrl,
    closed: job.closed,
    hasFullDescription: false,
  };
}

export function resolveHref(base: string, href: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/** Board token for a job or board URL on a known ATS host. */
export function inferBoardUrl(jobOrBoardUrl: string): string | null {
  const url = safeUrl(jobOrBoardUrl);
  if (url === null) {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    const forToken = url.searchParams.get("for");
    if (forToken !== null && forToken !== "") {
      return `${url.protocol}//${host}/${forToken}`;
    }
    if (parts[0] !== undefined && parts[0] !== "embed") {
      return `${url.protocol}//${host}/${parts[0]}`;
    }
    return null;
  }
  if (host === "jobs.ashbyhq.com" && parts[0] !== undefined) {
    return `${url.protocol}//${host}/${parts[0]}`;
  }
  if (host === "jobs.lever.co" && parts[0] !== undefined && parts[0] !== "embed" && parts[0] !== "api") {
    return `${url.protocol}//${host}/${parts[0]}`;
  }
  return null;
}

export function parseIsoDate(value: unknown): string | null {
  const raw = asString(value);
  if (raw === null) {
    return null;
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

export { asRecord, asString };
