export type FetchedPage = {
  url: string;
  status: number;
  body: string;
};

/** Load a page. Fixture-only; never point this at a live ATS host. */
export type FetchPage = (url: string) => Promise<FetchedPage>;
