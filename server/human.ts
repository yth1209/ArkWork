import type { Database } from "./database";
import { HttpError } from "./store";
import { event, toRun, type Row } from "./work";
import { rowPlan, hashPlan } from "./plans";

export async function respond(
  db: Database,
  workspace: string,
  id: string,
  version: number,
  action: string,
  text: string,
  key: string,
) {
  const value = text.trim();
  if (
    !["answer", "revise", "continue", "accept"].includes(action) ||
    value.length > 2000 ||
    (["answer", "revise"].includes(action) && value.length < 10)
  )
    throw new HttpError(
      422,
      "INVALID_INPUT",
      "답변과 수정 의견은 10~2,000자로 입력해 주세요.",
    );
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(key))
    throw new HttpError(422, "INVALID_KEY", "유효한 요청 키가 필요합니다.");
  return db.transaction(async (tx) => {
    await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
      workspace,
    ]);
    const row = (
      await tx.query<Row>(
        "SELECT * FROM work_items WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [workspace, id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "NOT_FOUND", "작업을 찾을 수 없습니다.");
    const requestHash = hashPlan({ version, action, text: value });
    const previous = (
      await tx.query(
        "SELECT * FROM human_responses WHERE work_id=$1 AND request_key=$2",
        [id, key],
      )
    ).rows[0];
    if (previous) {
      if (previous.request_hash !== requestHash)
        throw new HttpError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "같은 요청 키를 다른 의견에 사용할 수 없습니다.",
        );
      return { run: toRun(row), replayed: true };
    }
    if (row.version !== version)
      throw new HttpError(
        409,
        "VERSION_CONFLICT",
        "작업 상태가 변경됐습니다. 최신 내용을 확인한 뒤 다시 제출하세요.",
      );
    if (
      row.agent_task &&
      ["pending", "running", "cancelling"].includes(row.agent_task.status)
    )
      throw new HttpError(
        409,
        "AGENT_BUSY",
        "Codex 호출을 마치거나 중단한 뒤 응답하세요.",
      );
    if (!row.human_workflow)
      throw new HttpError(
        409,
        "LEGACY_WORK",
        "이전 작업은 단계별 개입을 지원하지 않습니다. 새 작업을 만들어 주세요.",
      );
    if (row.pull_request)
      throw new HttpError(
        409,
        "PR_REVIEW_REQUIRED",
        "연결된 PR 화면에서 변경 내용을 평가하세요. 모의 결과 승인으로 완료할 수 없습니다.",
      );
    const allowed: Record<string, string[]> = {
      awaiting_input: ["answer"],
      awaiting_run_approval: ["revise"],
      awaiting_decision: ["continue", "revise"],
      review_ready: ["accept", "revise"],
    };
    if (!allowed[row.state]?.includes(action))
      throw new HttpError(
        409,
        "INVALID_STATE",
        "현재 단계에서는 이 응답을 처리할 수 없습니다.",
      );
    if (row.human_history.length >= 100)
      throw new HttpError(
        429,
        "HISTORY_LIMIT",
        "응답 기록 한도에 도달했습니다. 새 작업으로 이어가 주세요.",
      );
    let state = row.state;
    if (action === "answer") {
      row.clarification = value;
      state = "awaiting_run_approval";
    } else if (action === "revise") {
      if (row.revision >= 3)
        throw new HttpError(
          429,
          "REVISION_LIMIT",
          "수정 회차는 3회까지 가능합니다. 새 작업으로 이어가 주세요.",
        );
      row.feedback = value;
      row.agent_specification = null;
      row.agent_task = null;
      row.revision++;
      row.stage = 0;
      row.decision = "";
      state = "awaiting_run_approval";
      // Revoke the previous job before creating a new plan. Old approval never
      // grants execution rights to a revised plan, even on a delayed retry.
      await tx.query(
        "UPDATE execution_jobs SET status='cancelled',lease_owner=NULL,lease_until=NULL,generation=generation+1,resume_pending=false WHERE work_id=$1",
        [id],
      );
    } else if (action === "continue") {
      // Continue only within the approved scope; scope changes require revise.
      const job = (
        await tx.query(
          "UPDATE execution_jobs SET status='pending',resume_pending=true,generation=generation+1 WHERE work_id=$1 AND status='waiting' RETURNING *",
          [id],
        )
      ).rows[0];
      if (!job)
        throw new HttpError(
          409,
          "JOB_CONFLICT",
          "대기 중인 실행을 찾을 수 없습니다.",
        );
      row.decision = value || "승인한 요구사항 범위를 유지하고 진행합니다.";
      state = "queued";
    } else if (action === "accept") {
      state = "completed";
    }
    const { plan, hash } = rowPlan(row);
    const history = [
      ...row.human_history,
      {
        action,
        text:
          value ||
          (action === "accept"
            ? "모의 결과를 확인하고 작업을 완료했습니다."
            : row.decision),
        at: new Date().toISOString(),
      },
    ];
    const result = (
      await tx.query<Row>(
        `UPDATE work_items SET state=$2,stage=$3,clarification=$4,feedback=$5,decision=$6,revision=$7,
      execution_plan=$8,plan_hash=$9,human_history=$10,agent_specification=$11,agent_task=$12,version=version+1, failure_reason=NULL WHERE id=$1 RETURNING *`,
        [
          id,
          state,
          row.stage,
          row.clarification,
          row.feedback,
          row.decision,
          row.revision,
          JSON.stringify(plan),
          hash,
          JSON.stringify(history),
          row.agent_specification
            ? JSON.stringify(row.agent_specification)
            : null,
          row.agent_task ? JSON.stringify(row.agent_task) : null,
        ],
      )
    ).rows[0];
    const actor = String(
      (
        await tx.query("SELECT identity FROM workspaces WHERE id=$1", [
          workspace,
        ])
      ).rows[0].identity,
    );
    await tx.query(
      "INSERT INTO human_responses (work_id,request_key,request_hash,actor) VALUES ($1,$2,$3,$4)",
      [id, key, requestHash, actor],
    );
    await event(tx, result, workspace, `human_${action}`);
    return { run: toRun(result), replayed: false };
  });
}
