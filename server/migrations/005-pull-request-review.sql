ALTER TABLE work_items ADD COLUMN pull_request jsonb;
CREATE UNIQUE INDEX work_pull_request_unique ON work_items ((pull_request->>'repository'), (pull_request->>'number')) WHERE pull_request->>'number' IS NOT NULL;
