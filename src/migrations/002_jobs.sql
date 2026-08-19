CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_job_id TEXT,
  apply_url TEXT NOT NULL UNIQUE,
  board_url TEXT,
  title TEXT NOT NULL,
  company_name TEXT NOT NULL,
  company_id TEXT,
  locations_json TEXT NOT NULL,
  remote INTEGER,
  employment_type TEXT,
  salary_json TEXT,
  description_markdown TEXT NOT NULL DEFAULT '',
  has_full_description INTEGER NOT NULL DEFAULT 0,
  posted_at TEXT,
  closed INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX jobs_board_url ON jobs (board_url);
