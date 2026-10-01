ALTER TABLE work_items DROP CONSTRAINT work_items_state_check;
UPDATE work_items SET state='awaiting_run_approval',stage=0 WHERE state IN ('received','running','verifying');
ALTER TABLE work_items ADD CONSTRAINT work_items_state_check CHECK (state IN ('awaiting_run_approval','queued','running','verifying','review_ready','cancelling','cancelled','failed'));
ALTER TABLE work_items ADD COLUMN plan_hash text;
ALTER TABLE work_items ADD COLUMN execution_plan jsonb;
ALTER TABLE work_items ADD COLUMN policy_version text;
ALTER TABLE work_items ADD COLUMN attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN failure_reason text;
CREATE TABLE work_approvals (
  id uuid PRIMARY KEY,
  work_id uuid UNIQUE NOT NULL REFERENCES work_items(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  approved_version integer NOT NULL,
  plan_hash text NOT NULL,
  policy_version text NOT NULL,
  approved_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE execution_jobs (
  work_id uuid PRIMARY KEY REFERENCES work_items(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  approval_id uuid NOT NULL REFERENCES work_approvals(id),
  status text NOT NULL CHECK (status IN ('pending','running','succeeded','cancelled','failed')),
  lease_owner uuid,
  lease_until timestamptz,
  generation integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX execution_jobs_pending ON execution_jobs(status,created_at);
