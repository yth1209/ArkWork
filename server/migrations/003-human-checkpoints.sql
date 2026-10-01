ALTER TABLE work_items DROP CONSTRAINT work_items_state_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_state_check CHECK (state IN ('awaiting_input','awaiting_run_approval','queued','running','verifying','awaiting_decision','review_ready','completed','cancelling','cancelled','failed'));
ALTER TABLE work_items ADD COLUMN human_workflow boolean NOT NULL DEFAULT false;
ALTER TABLE work_items ADD COLUMN clarification text NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN feedback text NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN decision text NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN revision integer NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN human_history jsonb NOT NULL DEFAULT '[]';
ALTER TABLE work_approvals DROP CONSTRAINT work_approvals_work_id_key;
CREATE UNIQUE INDEX work_approvals_revision ON work_approvals(work_id,approved_version);
ALTER TABLE execution_jobs DROP CONSTRAINT execution_jobs_status_check;
ALTER TABLE execution_jobs ADD CONSTRAINT execution_jobs_status_check CHECK (status IN ('pending','running','waiting','succeeded','cancelled','failed'));
ALTER TABLE execution_jobs ADD COLUMN resume_pending boolean NOT NULL DEFAULT false;
CREATE TABLE human_responses (
  work_id uuid NOT NULL REFERENCES work_items(id),
  request_key text NOT NULL,
  request_hash text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_id,request_key)
);
