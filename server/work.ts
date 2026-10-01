import type { Queryable } from "./database";
import type { Run, ExecutionPlan } from "../src/factory";

export type Row = Record<string, unknown> & {
  id: string;
  workspace_id: string;
  requirements: string;
  state: string;
  stage: number;
  version: number;
  created_at: Date | string;
  plan_hash: string | null;
  execution_plan: ExecutionPlan | null;
  policy_version: string | null;
  attempt_count: number;
  failure_reason: string | null;
};

export function toRun(row: Row): Run {
  const status: Run["status"] =
    row.state === "awaiting_run_approval"
      ? "awaiting_approval"
      : row.state === "queued"
        ? "queued"
        : row.state === "cancelling"
          ? "cancelling"
          : row.state === "failed"
            ? "failed"
            : row.state === "cancelled"
              ? "cancelled"
              : row.state === "review_ready"
                ? "review"
                : "running";
  return {
    id: row.id,
    prompt: row.requirements,
    stage: row.stage,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    state: row.state,
    status,
    planHash: row.plan_hash ?? undefined,
    plan: row.execution_plan ?? undefined,
    policyVersion: row.policy_version ?? undefined,
    attemptCount: row.attempt_count,
    failureReason: row.failure_reason ?? undefined,
  };
}

export async function event(
  tx: Queryable,
  row: Row,
  workspace: string,
  type: string,
) {
  await tx.query(
    "INSERT INTO work_events (work_id,sequence,workspace_id,type,payload) VALUES ($1,$2,$3,$4,$5)",
    [row.id, row.version, workspace, type, JSON.stringify(toRun(row))],
  );
}
