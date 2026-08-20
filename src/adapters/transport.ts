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

const LIVE_TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isLiveAtsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[LIVE_ATS_ENV];
  if (raw === undefined) {
    return false;
  }
  return LIVE_TRUTHY.has(raw.trim().toLowerCase());
}
