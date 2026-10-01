CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  identity text UNIQUE NOT NULL
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  expires_at timestamptz NOT NULL
);
CREATE TABLE projects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE work_items (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  requirements text NOT NULL CHECK (length(requirements) BETWEEN 10 AND 10000),
  state text NOT NULL CHECK (state IN ('received','running','verifying','review_ready','cancelled')),
  stage integer NOT NULL DEFAULT 0 CHECK (stage BETWEEN 0 AND 4),
  version integer NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  next_step_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, idempotency_key)
);
CREATE TABLE work_events (
  work_id uuid NOT NULL REFERENCES work_items(id),
  sequence integer NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(work_id, sequence)
);
CREATE INDEX work_items_workspace_created ON work_items(workspace_id, created_at DESC, id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
