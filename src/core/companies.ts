import { inferBoardUrl, normalizeUrl, safeUrl, toJobSummary } from "../adapters/parse.js";
import type { HireApiDb } from "../db.js";
import type { JobSummary } from "../types.js";
import { HireError } from "./errors.js";
import { listStoredJobsForCompany } from "./store.js";

export type Company = {
  id: string;
  name: string;
  boardUrl: string | null;
  createdAt: string;
};

type CompanyRow = {
  id: string;
  name: string;
  board_url: string | null;
  created_at: string;
};

export type CompanyJobsPage = {
  jobs: JobSummary[];
  nextCursor: null;
};

function rowToCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    name: row.name,
    boardUrl: row.board_url,
    createdAt: row.created_at,
  };
}

function slugToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Stable id from a board URL so the same board always maps to the same company. */
export function companyIdForBoard(boardUrl: string): string | null {
  const inferred = inferBoardUrl(boardUrl) ?? normalizeUrl(boardUrl);
  if (inferred === null) {
    return null;
  }
  const url = safeUrl(inferred);
  if (url === null) {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const token = url.pathname.split("/").filter(Boolean)[0];
  if (token === undefined || token === "") {
    return null;
  }
  const slug = slugToken(token);
  if (slug === "") {
    return null;
  }
  if (host.includes("greenhouse")) {
    return `co_greenhouse_${slug}`;
  }
  if (host.includes("ashby")) {
    return `co_ashby_${slug}`;
  }
  if (host.includes("lever")) {
    return `co_lever_${slug}`;
  }
  return `co_${slug}`;
}

function normalizeBoard(boardUrl: string | null): string | null {
  if (boardUrl === null || boardUrl.trim() === "") {
    return null;
  }
  return inferBoardUrl(boardUrl) ?? normalizeUrl(boardUrl) ?? boardUrl;
}

export function getCompany(db: HireApiDb, id: string): Company | null {
  const trimmed = id.trim();
  if (trimmed === "") {
    return null;
  }
  const row = db
    .prepare<[string], CompanyRow>("SELECT * FROM companies WHERE id = ?")
    .get(trimmed);
  return row === undefined ? null : rowToCompany(row);
}

export function getCompanyByBoardUrl(db: HireApiDb, boardUrl: string): Company | null {
  const board = normalizeBoard(boardUrl);
  if (board === null) {
    return null;
  }
  const row = db
    .prepare<[string], CompanyRow>("SELECT * FROM companies WHERE board_url = ?")
    .get(board);
  return row === undefined ? null : rowToCompany(row);
}

function persistNameAndBoard(db: HireApiDb, company: Company, name: string, board: string | null): Company {
  const nextName = name !== "" ? name : company.name;
  const nextBoard = company.boardUrl ?? board;
  if (nextName === company.name && nextBoard === company.boardUrl) {
    return company;
  }
  db.prepare("UPDATE companies SET name = ?, board_url = COALESCE(board_url, ?) WHERE id = ?").run(
    nextName,
    nextBoard,
    company.id,
  );
  return { ...company, name: nextName, boardUrl: nextBoard };
}

/**
 * Create or reuse the company for an ingested board. Same board URL → same id.
 */
export function ensureCompany(
  db: HireApiDb,
  input: { name: string; boardUrl: string | null; existingId?: string | null },
): Company {
  const name = input.name.trim();
  const board = normalizeBoard(input.boardUrl);
  const now = new Date().toISOString();

  if (board !== null) {
    const byBoard = getCompanyByBoardUrl(db, board);
    if (byBoard !== null) {
      return persistNameAndBoard(db, byBoard, name, board);
    }
  }

  const existingId = input.existingId?.trim() ?? "";
  if (existingId !== "") {
    const existing = getCompany(db, existingId);
    if (existing !== null) {
      return persistNameAndBoard(db, existing, name, board);
    }
  }

  const id = (board !== null ? companyIdForBoard(board) : null) ?? `co_${slugToken(name) || "unknown"}`;
  const already = getCompany(db, id);
  if (already !== null) {
    return persistNameAndBoard(db, already, name, board);
  }

  db.prepare(
    `INSERT INTO companies (id, name, board_url, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, name !== "" ? name : id, board, now);
  return {
    id,
    name: name !== "" ? name : id,
    boardUrl: board,
    createdAt: now,
  };
}

export function listCompanyJobs(db: HireApiDb, companyId: string): CompanyJobsPage {
  const company = getCompany(db, companyId);
  if (company === null) {
    throw new HireError("not_found", "Unknown company id.");
  }
  const jobs = listStoredJobsForCompany(db, company.id)
    .filter((stored) => !stored.job.closed)
    .map((stored) => toJobSummary(stored.job))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return { jobs, nextCursor: null };
}
