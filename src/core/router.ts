import { createAdapters, createFetchPage } from "../adapters/index.js";
import type { FetchPage } from "../adapters/transport.js";
import type { BoardAdapter } from "../types.js";
import { HireError } from "./errors.js";

/** Default is fixture HTML. Live ATS only when HIREAPI_LIVE_ATS is set. */
export function defaultAdapters(fetchPage: FetchPage = createFetchPage()): BoardAdapter[] {
  return createAdapters(fetchPage);
}

export function parseRequestedUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") {
    throw new HireError("invalid_request", "Query parameter url is required.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HireError("invalid_request", "Query parameter url must be an absolute URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HireError("invalid_request", "Query parameter url must be http or https.");
  }
  const host = parsed.hostname.toLowerCase();
  if (host.includes("linkedin.com") || host.includes("indeed.com") || host.includes("indeed.")) {
    throw new HireError("source_disabled", "LinkedIn and Indeed are not enabled.");
  }
  return trimmed;
}

export function adapterForJobUrl(
  url: string,
  adapters: readonly BoardAdapter[] = defaultAdapters(),
): BoardAdapter | null {
  for (const adapter of adapters) {
    if (adapter.matchJobUrl(url)) {
      return adapter;
    }
  }
  return null;
}

export function adapterForBoardUrl(
  url: string,
  adapters: readonly BoardAdapter[] = defaultAdapters(),
): BoardAdapter | null {
  for (const adapter of adapters) {
    if (adapter.matchBoardUrl(url)) {
      return adapter;
    }
  }
  return null;
}
