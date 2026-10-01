import type { Queryable } from "./database";
import type {
  Run,
  ExecutionPlan,
  Specification,
  AgentTask,
  PullRequestReview,
} from "../src/factory";

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
  human_workflow: boolean;
  pull_request: PullRequestReview | null;
  agent_questions: string[] | null;
  agent_specification: Specification | null;
  agent_task: AgentTask | null;
  clarification: string;
  feedback: string;
  decision: string;
  revision: number;
  human_history: { action: string; text: string; at: string }[];
};

export function toRun(row: Row): Run {
  const status: Run["status"] = [
    "awaiting_input",
    "awaiting_decision",
    "completed",
  ].includes(row.state)
    ? (row.state as Run["status"])
    : row.state === "awaiting_run_approval"
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
    humanWorkflow: row.human_workflow,
    pullRequest: row.pull_request ?? undefined,
    agentQuestions: row.agent_questions ?? undefined,
    agentSpecification: row.agent_specification ?? undefined,
    agentTask: row.agent_task ?? undefined,
    clarification: row.clarification,
    feedback: row.feedback,
    decision: row.decision,
    revision: row.revision,
    humanHistory: row.human_history,
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
