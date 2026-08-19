CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  board_url TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX jobs_company_id ON jobs (company_id);
