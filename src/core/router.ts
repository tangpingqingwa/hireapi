import { createAshbyAdapter } from "../adapters/ashby.js";
import { createFixtureFetchPage } from "../adapters/fixtures.js";
import { createGreenhouseAdapter } from "../adapters/greenhouse.js";
import type { FetchPage } from "../adapters/transport.js";
import type { BoardAdapter } from "../types.js";
import { HireError } from "./errors.js";

export function defaultAdapters(fetchPage: FetchPage = createFixtureFetchPage()): BoardAdapter[] {
  return [createGreenhouseAdapter(fetchPage), createAshbyAdapter(fetchPage)];
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
