import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HireError } from "../core/errors.js";
import type { AdapterVendor } from "../types.js";
import { hostOf, normalizeUrl } from "./parse.js";
import type { FetchedPage, FetchPage } from "./transport.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../tests/fixtures/boards",
);

export type FixtureIndexEntry = {
  url: string;
  file: string;
  vendor: AdapterVendor;
  kind: "job" | "board";
  status?: number;
};

export type FixtureIndex = {
  jobs: FixtureIndexEntry[];
};

function fixtureBodyPath(file: string): string {
  return join(FIXTURES_DIR, file);
}

export function loadFixtureIndex(): FixtureIndex {
  const raw = readFileSync(join(FIXTURES_DIR, "index.json"), "utf8");
  return JSON.parse(raw) as FixtureIndex;
}

function sameJobUrl(left: string, right: string): boolean {
  const a = normalizeUrl(left);
  const b = normalizeUrl(right);
  if (a !== null && b !== null && a === b) {
    return true;
  }
  try {
    const ua = new URL(left);
    const ub = new URL(right);
    const ha = ua.hostname.toLowerCase().replace(/^www\./, "");
    const hb = ub.hostname.toLowerCase().replace(/^www\./, "");
    if (ha !== hb) {
      return false;
    }
    const pa = ua.pathname.replace(/\/+$/, "");
    const pb = ub.pathname.replace(/\/+$/, "");
    if (pa !== pb) {
      return false;
    }
    const tokenA = ua.searchParams.get("token") ?? ua.searchParams.get("gh_jid");
    const tokenB = ub.searchParams.get("token") ?? ub.searchParams.get("gh_jid");
    if (tokenA !== null || tokenB !== null) {
      return tokenA === tokenB;
    }
    return true;
  } catch {
    return false;
  }
}

export function createFixtureFetchPage(index = loadFixtureIndex()): FetchPage {
  return async (url: string): Promise<FetchedPage> => {
    const host = hostOf(url);
    if (host === null) {
      throw new HireError("invalid_request", "URL is not a valid http(s) job link.");
    }
    const match = index.jobs.find((entry) => sameJobUrl(entry.url, url));
    if (match === undefined) {
      throw new HireError(
        "upstream_blocked",
        "No fixture for this URL (live Greenhouse/Ashby/Lever is disabled).",
      );
    }
    const status = match.status ?? 200;
    const body = match.file === "" ? "" : readFileSync(fixtureBodyPath(match.file), "utf8");
    return {
      url: match.url,
      status,
      body,
    };
  };
}

export function fixtureJobUrls(
  vendor?: AdapterVendor,
  index = loadFixtureIndex(),
): string[] {
  return index.jobs
    .filter((entry) => entry.kind === "job" && (vendor === undefined || entry.vendor === vendor))
    .filter((entry) => (entry.status ?? 200) === 200)
    .map((entry) => entry.url);
}

export function fixtureBoardUrls(
  vendor?: AdapterVendor,
  index = loadFixtureIndex(),
): string[] {
  return index.jobs
    .filter((entry) => entry.kind === "board" && (vendor === undefined || entry.vendor === vendor))
    .filter((entry) => (entry.status ?? 200) === 200)
    .map((entry) => entry.url);
}
