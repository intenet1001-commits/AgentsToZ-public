CREATE TABLE IF NOT EXISTS portmgr_project_memory_revisions (
  id text PRIMARY KEY,
  memory_id text NOT NULL,
  parent_revision_id text,
  project_name text,
  github_url text,
  device_id text,
  device_name text,
  source_path text,
  content text NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portmgr_project_memory_latest
  ON portmgr_project_memory_revisions(memory_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_portmgr_project_memory_github
  ON portmgr_project_memory_revisions(github_url, created_at DESC);

-- The app currently connects with its configured anon key, matching the other
-- portmgr_* tables. Memory content must not contain secrets or credentials.
ALTER TABLE portmgr_project_memory_revisions DISABLE ROW LEVEL SECURITY;
