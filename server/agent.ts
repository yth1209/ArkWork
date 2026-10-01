import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "./database";
import {
  AgentError,
  type AgentProvider,
  type Phase,
  type AgentInput,
} from "./codex";
import { hashPlan, rowPlan } from "./plans";
import { event, toRun, type Row } from "./work";
import { HttpError } from "./store";

export const agentInput = (row: Row): AgentInput => ({
  requirements: row.requirements,
  clarification: row.clarification,
  feedback: row.feedback,
  revision: row.revision,
  questions: row.agent_questions ?? null,
});
const activeStates = ["pending", "running", "cancelling"];
type Call = Record<string, unknown> & {
  id: string;
  work_id: string;
  workspace_id: string;
  phase: Phase;
  input: AgentInput;
  input_hash: string;
  status: string;
  worker_id: string;
};

export class AgentService {
  readonly worker = randomUUID();
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private closed = false;
  constructor(
    private db: Database,
    readonly provider: AgentProvider,
    private timeoutMs = 120000,
  ) {}
  async start(
    workspace: string,
    id: string,
    version: number,
    phase: Phase,
    key: string,
  ) {
    if (
      !["questions", "specification"].includes(phase) ||
      !/^[a-zA-Z0-9-]{8,100}$/.test(key)
    )
      throw new HttpError(
        422,
        "INVALID_INPUT",
        "호출 종류와 요청 키를 확인하세요.",
      );
    // Access and idempotency precede auth checks; retries cannot create a second call.
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        workspace,
      ]);
      const row = (
        await tx.query<Row>(
          "SELECT * FROM work_items WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [workspace, id],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(404, "NOT_FOUND", "작업을 찾을 수 없습니다.");
      const actor = String(
        (
          await tx.query("SELECT identity FROM workspaces WHERE id=$1", [
            workspace,
          ])
        ).rows[0].identity,
      );
      if (actor !== "owner")
        throw new HttpError(
          403,
          "OWNER_ONLY",
          "현재 구독 연결은 로컬 개발 owner 계정에서만 사용합니다.",
        );
      const previous = (
        await tx.query(
          "SELECT * FROM agent_calls WHERE work_id=$1 AND request_key=$2",
          [id, key],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.phase !== phase ||
          Number(previous.request_version) !== version
        )
          throw new HttpError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "같은 요청 키를 다른 호출에 사용할 수 없습니다.",
          );
        return { run: toRun(row), replayed: true };
      }
      if (row.version !== version)
        throw new HttpError(
          409,
          "VERSION_CONFLICT",
          "최신 작업 내용을 확인한 뒤 실행하세요.",
        );
      const target =
        phase === "questions" ? "awaiting_input" : "awaiting_run_approval";
      if (!row.human_workflow || row.state !== target)
        throw new HttpError(
          409,
          "INVALID_STATE",
          "현재 단계에서는 이 Codex 호출을 실행할 수 없습니다.",
        );
      if (
        (phase === "questions" && row.agent_questions) ||
        (phase === "specification" && row.agent_specification)
      )
        throw new HttpError(
          409,
          "ALREADY_GENERATED",
          "현재 회차의 Codex 결과가 이미 있습니다. 변경할 내용은 수정 의견으로 제출하세요.",
        );
      const busy = (
        await tx.query(
          "SELECT id FROM agent_calls WHERE workspace_id=$1 AND status IN ('pending','running','cancelling')",
          [workspace],
        )
      ).rows;
      if (busy.length)
        throw new HttpError(
          429,
          "AGENT_BUSY",
          "Codex 호출은 한 번에 한 건만 가능합니다.",
        );
      const attempts = (
        await tx.query(
          "SELECT count(*)::int AS count FROM agent_calls WHERE work_id=$1 AND phase=$2 AND revision=$3",
          [id, phase, row.revision],
        )
      ).rows[0];
      if (Number(attempts.count) >= 2)
        throw new HttpError(
          429,
          "AGENT_LIMIT",
          "회차별 같은 종류의 Codex 호출은 2회까지 가능합니다. 자동 재시도는 하지 않습니다.",
        );
      const status = await this.provider.status();
      if (!status.enabled || !status.authenticated)
        throw new HttpError(409, "CODEX_AUTH_REQUIRED", status.message);
      const callId = randomUUID(),
        input = agentInput(row);
      await tx.query(
        "INSERT INTO agent_calls (id,work_id,workspace_id,phase,revision,request_key,request_version,input_hash,input,status,actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)",
        [
          callId,
          id,
          workspace,
          phase,
          row.revision,
          key,
          version,
          hashPlan(input),
          JSON.stringify(input),
          actor,
        ],
      );
      const updated = (
        await tx.query<Row>(
          "UPDATE work_items SET agent_task=$2,version=version+1 WHERE id=$1 RETURNING *",
          [id, JSON.stringify({ id: callId, phase, status: "pending" })],
        )
      ).rows[0];
      await event(tx, updated, workspace, "codex_queued");
      return { run: toRun(updated), replayed: false };
    });
  }
  async cancel(workspace: string, id: string) {
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        workspace,
      ]);
      const row = (
        await tx.query<Row>(
          "SELECT * FROM work_items WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [workspace, id],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(404, "NOT_FOUND", "작업을 찾을 수 없습니다.");
      const task = row.agent_task;
      if (!task || !activeStates.includes(task.status)) return;
      const status = task.status === "pending" ? "cancelled" : "cancelling";
      await tx.query(
        "UPDATE agent_calls SET status=$2 WHERE id=$1 AND workspace_id=$3",
        [task.id, status, workspace],
      );
      const updated = (
        await tx.query<Row>(
          "UPDATE work_items SET agent_task=$2,version=version+1 WHERE id=$1 RETURNING *",
          [id, JSON.stringify({ ...task, status })],
        )
      ).rows[0];
      await event(tx, updated, workspace, "codex_cancel_requested");
      this.active.get(task.id)?.controller.abort();
    });
    return this.get(workspace, id);
  }
  private async get(workspace: string, id: string) {
    return toRun(
      (
        await this.db.query<Row>(
          "SELECT * FROM work_items WHERE workspace_id=$1 AND id=$2",
          [workspace, id],
        )
      ).rows[0],
    );
  }
  private async update(
    tx: Queryable,
    row: Row,
    call: Call,
    status: string,
    errorCode?: string,
  ) {
    const updated = (
      await tx.query<Row>(
        "UPDATE work_items SET agent_task=$2,version=version+1 WHERE id=$1 RETURNING *",
        [
          row.id,
          JSON.stringify({
            id: call.id,
            phase: call.phase,
            status,
            ...(errorCode ? { errorCode } : {}),
          }),
        ],
      )
    ).rows[0];
    await event(tx, updated, row.workspace_id, `codex_${status}`);
  }
  async tick() {
    if (this.closed) return;
    // A crashed call is marked failed, never replayed against subscription quota.
    const interrupted = await this.db.query<Call>(
      "SELECT * FROM agent_calls WHERE status IN ('running','cancelling') AND expires_at<=now()",
    );
    for (const call of interrupted.rows)
      await this.finish(call, undefined, "INTERRUPTED");
    for (const [id, active] of this.active) {
      const row = (
        await this.db.query("SELECT status FROM agent_calls WHERE id=$1", [id])
      ).rows[0];
      if (row?.status !== "running") active.controller.abort();
    }
    if (this.active.size) return;
    const call = await this.db.transaction(async (tx) => {
      const spaces = await tx.query(
        "SELECT id FROM workspaces WHERE EXISTS (SELECT 1 FROM agent_calls WHERE workspace_id=workspaces.id AND status='pending') ORDER BY id FOR UPDATE SKIP LOCKED",
      );
      for (const space of spaces.rows) {
        if (
          (
            await tx.query(
              "SELECT id FROM agent_calls WHERE workspace_id=$1 AND status IN ('running','cancelling')",
              [space.id],
            )
          ).rows.length
        )
          continue;
        const next = (
          await tx.query<Call>(
            "SELECT * FROM agent_calls WHERE workspace_id=$1 AND status='pending' ORDER BY created_at,id LIMIT 1",
            [space.id],
          )
        ).rows[0];
        const row = (
          await tx.query<Row>(
            "SELECT * FROM work_items WHERE id=$1 FOR UPDATE",
            [next.work_id],
          )
        ).rows[0];
        if (
          row.agent_task?.id !== next.id ||
          hashPlan(agentInput(row)) !== next.input_hash ||
          row.state !==
            (next.phase === "questions"
              ? "awaiting_input"
              : "awaiting_run_approval")
        ) {
          await tx.query(
            "UPDATE agent_calls SET status='cancelled' WHERE id=$1",
            [next.id],
          );
          if (row.agent_task?.id === next.id)
            await this.update(tx, row, next, "cancelled");
          continue;
        }
        await tx.query(
          "UPDATE agent_calls SET status='running',worker_id=$2,expires_at=now()+$3*interval '1 millisecond' WHERE id=$1",
          [next.id, this.worker, this.timeoutMs + 10000],
        );
        await this.update(tx, row, next, "running");
        return { ...next, worker_id: this.worker };
      }
    });
    if (!call) return;
    if (this.closed) {
      await this.finish(call, undefined, "ABORTED");
      return;
    }
    const controller = new AbortController();
    const promise = this.execute(call, controller)
      .catch(() => {
        console.error(
          "Codex 실행 상태를 저장하지 못했습니다. 자동 재호출하지 않습니다.",
        );
      })
      .finally(() => this.active.delete(call.id));
    this.active.set(call.id, { controller, promise });
  }
  private async execute(call: Call, controller: AbortController) {
    const timeout = setTimeout(
      () =>
        controller.abort(
          new AgentError("TIMEOUT", "Codex 실행 시간 제한에 도달했습니다."),
        ),
      this.timeoutMs,
    );
    try {
      const result = await this.provider.run(
        call.phase,
        call.input,
        controller.signal,
      );
      await this.finish(call, result);
    } catch (error) {
      await this.finish(
        call,
        undefined,
        controller.signal.aborted
          ? controller.signal.reason instanceof AgentError
            ? controller.signal.reason.code
            : "ABORTED"
          : error instanceof AgentError
            ? error.code
            : "CODEX_FAILED",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  private async finish(
    call: Call,
    result?: Awaited<ReturnType<AgentProvider["run"]>>,
    errorCode?: string,
  ) {
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        call.workspace_id,
      ]);
      const row = (
        await tx.query<Row>("SELECT * FROM work_items WHERE id=$1 FOR UPDATE", [
          call.work_id,
        ])
      ).rows[0];
      const current = (
        await tx.query<Call>(
          "SELECT *, expires_at<=now() AS expired FROM agent_calls WHERE id=$1 FOR UPDATE",
          [call.id],
        )
      ).rows[0];
      if (!current || !["running", "cancelling"].includes(current.status))
        return;
      if (errorCode !== "INTERRUPTED" && current.worker_id !== this.worker)
        return;
      const cancelled =
        current.status === "cancelling" ||
        row.state === "cancelled" ||
        row.agent_task?.id !== call.id;
      const stale =
        hashPlan(agentInput(row)) !== call.input_hash ||
        row.state !==
          (call.phase === "questions"
            ? "awaiting_input"
            : "awaiting_run_approval");
      if (current.expired) {
        result = undefined;
        errorCode = "INTERRUPTED";
      }
      const status = cancelled
        ? "cancelled"
        : result && !stale
          ? "succeeded"
          : "failed";
      const code = stale ? "STALE_INPUT" : errorCode;
      await tx.query(
        "UPDATE agent_calls SET status=$2,error_code=$3,thread_id=$4,usage=$5 WHERE id=$1",
        [
          call.id,
          status,
          code ?? null,
          result?.threadId ?? null,
          result?.usage ? JSON.stringify(result.usage) : null,
        ],
      );
      if (row.agent_task?.id !== call.id) return;
      if (status === "succeeded" && result) {
        if (call.phase === "questions")
          row.agent_questions = result.output as string[];
        else
          row.agent_specification = result.output as Row["agent_specification"];
        const { plan, hash } = rowPlan(row);
        await tx.query(
          "UPDATE work_items SET agent_questions=$2,agent_specification=$3,execution_plan=$4,plan_hash=$5 WHERE id=$1",
          [
            row.id,
            row.agent_questions ? JSON.stringify(row.agent_questions) : null,
            row.agent_specification
              ? JSON.stringify(row.agent_specification)
              : null,
            JSON.stringify(plan),
            hash,
          ],
        );
      }
      const latest = (
        await tx.query<Row>("SELECT * FROM work_items WHERE id=$1", [row.id])
      ).rows[0];
      await this.update(tx, latest, call, status, code);
    });
  }
  async close() {
    this.closed = true;
    for (const item of this.active.values()) item.controller.abort();
    await Promise.allSettled(
      [...this.active.values()].map((item) => item.promise),
    );
  }
  async drain() {
    await Promise.all([...this.active.values()].map((item) => item.promise));
  }
}
