import type { BoardAdapter } from "../types.js";
import { createAshbyAdapter } from "./ashby.js";
import { createFixtureFetchPage } from "./fixtures.js";
import { createGreenhouseAdapter } from "./greenhouse.js";
import { createLeverAdapter } from "./lever.js";
import { createLiveFetchPage } from "./live.js";
import {
  isLiveAtsEnabled,
  wrapForceClosedAfterFirstFetch,
  type FetchPage,
} from "./transport.js";

export function createFetchPage(env: NodeJS.ProcessEnv = process.env): FetchPage {
  const inner = isLiveAtsEnabled(env) ? createLiveFetchPage() : createFixtureFetchPage();
  return wrapForceClosedAfterFirstFetch(inner, env.HIREAPI_SMOKE_FORCE_CLOSED);
}

export function createAdapters(fetchPage: FetchPage = createFetchPage()): BoardAdapter[] {
  return [
    createGreenhouseAdapter(fetchPage),
    createAshbyAdapter(fetchPage),
    createLeverAdapter(fetchPage),
  ];
}
