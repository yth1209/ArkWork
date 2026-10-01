import { createHash } from "node:crypto";
import type { Database } from "./database";
import { event, type Row } from "./work";

export const policyVersion = "fixture-v1";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const hashPlan = (plan: unknown) =>
  createHash("sha256").update(canonical(plan)).digest("hex");
export function executionPlan(
  requirements: string,
  human?: { clarification: string; feedback: string; revision: number },
) {
  const plan = {
    executionMode: "fixture" as const,
    requirements,
    ...(human ? { human } : {}),
    steps: [
      "요구사항 분석",
      "구현 계획",
      human ? "구현 전 사용자 결정 요청" : "구현 모의",
      "검증 모의",
      "결과 검토",
    ],
    limits: { maxSteps: 4, maxAttempts: 2 },
    policyVersion,
    scope:
      "서버 모의 진행만 수행합니다. AI 호출, 저장소 수정, 실제 테스트·PR·배포는 실행하지 않습니다.",
  };
  return { plan, hash: hashPlan(plan) };
}

// Existing active fixtures were not explicitly approved. Prepare them for review,
// retaining completed history and never silently grandfathering execution rights.
export async function prepareLegacyPlans(db: Database) {
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<Row>(
      "SELECT * FROM work_items WHERE state='awaiting_run_approval' AND plan_hash IS NULL FOR UPDATE",
    );
    for (const row of rows) {
      const { plan, hash } = executionPlan(row.requirements);
      const result = await tx.query<Row>(
        "UPDATE work_items SET plan_hash=$2,execution_plan=$3,policy_version=$4,version=version+1 WHERE id=$1 RETURNING *",
        [row.id, hash, JSON.stringify(plan), policyVersion],
      );
      await event(
        tx,
        result.rows[0],
        String(row.workspace_id),
        "approval_required",
      );
    }
  });
}

export function rowPlan(row: Row) {
  return executionPlan(
    row.requirements,
    row.human_workflow
      ? {
          clarification: row.clarification,
          feedback: row.feedback,
          revision: row.revision,
        }
      : undefined,
  );
}
