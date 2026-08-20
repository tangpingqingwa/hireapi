import type { BoardAdapter } from "../types.js";
import { createAshbyAdapter } from "./ashby.js";
import { createFixtureFetchPage } from "./fixtures.js";
import { createGreenhouseAdapter } from "./greenhouse.js";
import { createLeverAdapter } from "./lever.js";
import { createLiveFetchPage } from "./live.js";
import { isLiveAtsEnabled, type FetchPage } from "./transport.js";

export function createFetchPage(env: NodeJS.ProcessEnv = process.env): FetchPage {
  if (isLiveAtsEnabled(env)) {
    return createLiveFetchPage();
  }
  return createFixtureFetchPage();
}

export function createAdapters(fetchPage: FetchPage = createFetchPage()): BoardAdapter[] {
  return [
    createGreenhouseAdapter(fetchPage),
    createAshbyAdapter(fetchPage),
    createLeverAdapter(fetchPage),
  ];
}
