export type FetchedPage = {
  url: string;
  status: number;
  body: string;
};

/**
 * Load a page. Default is fixture HTML. Live HTTP lives in `live.ts`
 * and is only selected when HIREAPI_LIVE_ATS is truthy.
 */
export type FetchPage = (url: string) => Promise<FetchedPage>;

export const LIVE_ATS_ENV = "HIREAPI_LIVE_ATS";
export const SMOKE_FORCE_CLOSED_ENV = "HIREAPI_SMOKE_FORCE_CLOSED";

const LIVE_TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isLiveAtsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[LIVE_ATS_ENV];
  if (raw === undefined) {
    return false;
  }
  return LIVE_TRUTHY.has(raw.trim().toLowerCase());
}

function normalizeLookup(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

const forceClosedHits = new Map<string, number>();

/**
 * Live-smoke only. After this URL has been fetched once as a *job* page,
 * later GETs of the same URL return HTTP 404 so a known job becomes
 * 200 closed:true. Unset in CI. Hit counts are process-wide.
 */
export function wrapForceClosedAfterFirstFetch(
  fetchPage: FetchPage,
  closedUrl: string | undefined = process.env[SMOKE_FORCE_CLOSED_ENV],
): FetchPage {
  if (closedUrl === undefined || closedUrl.trim() === "") {
    return fetchPage;
  }
  const target = normalizeLookup(closedUrl);
  return async (url: string): Promise<FetchedPage> => {
    if (normalizeLookup(url) === target) {
      const seen = forceClosedHits.get(target) ?? 0;
      if (seen >= 1) {
        return { url, status: 404, body: "" };
      }
      const page = await fetchPage(url);
      forceClosedHits.set(target, seen + 1);
      return page;
    }
    return fetchPage(url);
  };
}
