ALTER TABLE work_items ADD COLUMN agent_questions jsonb;
ALTER TABLE work_items ADD COLUMN agent_specification jsonb;
ALTER TABLE work_items ADD COLUMN agent_task jsonb;
CREATE TABLE agent_calls (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES work_items(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  phase text NOT NULL CHECK (phase IN ('questions','specification')),
  revision integer NOT NULL,
  request_key text NOT NULL,
  request_version integer NOT NULL,
  input_hash text NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','running','cancelling','succeeded','failed','cancelled')),
  actor text NOT NULL,
  worker_id uuid,
  expires_at timestamptz,
  thread_id text,
  usage jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id,request_key)
);
CREATE INDEX agent_calls_pending ON agent_calls(status,created_at);
