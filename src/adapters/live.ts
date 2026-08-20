import { HireError } from "../core/errors.js";
import { hostOf } from "./parse.js";
import type { FetchedPage, FetchPage } from "./transport.js";

const ALLOWED_HOSTS = new Set([
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.ashbyhq.com",
  "jobs.lever.co",
]);

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "HireAPI/0.1 (+https://github.com/tangpingqingwa/hireapi)";

export type LiveFetch = (url: string, init: RequestInit) => Promise<Response>;

export type LiveFetchPageOptions = {
  fetchImpl?: LiveFetch;
  timeoutMs?: number;
};

function isAllowedHost(host: string): boolean {
  return ALLOWED_HOSTS.has(host);
}

function classifyTransportFailure(err: unknown): HireError {
  if (err instanceof HireError) {
    return err;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new HireError("upstream_blocked", "Live ATS request timed out.");
  }
  const message = err instanceof Error ? err.message : "Live ATS request failed.";
  return new HireError("upstream_blocked", message);
}

/**
 * GET a public Greenhouse / Ashby / Lever board or job page.
 * Transport failures are `upstream_blocked` (0 credits at the HTTP layer).
 * LinkedIn / Indeed and any other host are never fetched.
 */
export function createLiveFetchPage(options: LiveFetchPageOptions = {}): FetchPage {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (url: string): Promise<FetchedPage> => {
    const host = hostOf(url);
    if (host === null) {
      throw new HireError("invalid_request", "URL is not a valid http(s) job link.");
    }
    if (!isAllowedHost(host)) {
      throw new HireError(
        "unsupported_board",
        "Live fetch is limited to Greenhouse, Ashby, and Lever public boards.",
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let current = url;
      let response: Response | undefined;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        response = await fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            "user-agent": USER_AGENT,
          },
        });
        if (response.status < 300 || response.status >= 400) {
          if (response.status === 404) {
            return { url: current, status: 404, body: "" };
          }
          break;
        }
        const location = response.headers.get("location");
        if (location === null || location === "") {
          throw new HireError("upstream_blocked", "Live ATS returned a redirect without Location.");
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new HireError("upstream_blocked", "Live ATS returned an invalid redirect.");
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new HireError("upstream_blocked", "Live ATS redirected to a non-http URL.");
        }
        const nextHost = next.hostname.toLowerCase().replace(/^www\./, "");
        if (!isAllowedHost(nextHost)) {
          throw new HireError(
            "unsupported_board",
            "Live ATS redirected off Greenhouse, Ashby, or Lever.",
          );
        }
        current = next.toString();
        if (hop === MAX_REDIRECTS) {
          throw new HireError("upstream_blocked", "Live ATS exceeded redirect limit.");
        }
      }
      if (response === undefined) {
        throw new HireError("upstream_blocked", "Live ATS returned no response.");
      }
      const body = await response.text();
      return {
        url: current,
        status: response.status,
        body,
      };
    } catch (err) {
      throw classifyTransportFailure(err);
    } finally {
      clearTimeout(timer);
    }
  };
}
