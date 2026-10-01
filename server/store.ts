import { randomUUID } from "node:crypto";
import type { Database } from "./database";
import { event, toRun, type Row } from "./work";
import { executionPlan, policyVersion } from "./plans";
import { respond } from "./human";
import { FixtureQueue } from "./queue";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class Store {
  readonly queue: FixtureQueue;
  constructor(
    public db: Database,
    intervalMs = 1800,
    leaseMs = 5000,
  ) {
    this.queue = new FixtureQueue(db, intervalMs, leaseMs);
  }

  async projects(workspace: string) {
    return (
      await this.db.query(
        "SELECT id, name FROM projects WHERE workspace_id=$1 ORDER BY created_at,id",
        [workspace],
      )
    ).rows;
  }

  async createProject(workspace: string, name: string) {
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO projects (id,workspace_id,name) VALUES ($1,$2,$3)",
      [id, workspace, name],
    );
    return { id, name };
  }

  async list(workspace: string) {
    return (
      await this.db.query<Row>(
        "SELECT * FROM work_items WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 100",
        [workspace],
      )
    ).rows.map(toRun);
  }

  async get(workspace: string, id: string) {
    const { rows } = await this.db.query<Row>(
      "SELECT * FROM work_items WHERE workspace_id=$1 AND id=$2",
      [workspace, id],
    );
    if (!rows[0])
      throw new HttpError(404, "NOT_FOUND", "작업을 찾을 수 없습니다.");
    return toRun(rows[0]);
  }

  async create(
    workspace: string,
    project: string,
    requirements: string,
    key: string,
    humanWorkflow = true,
  ) {
    return this.db.transaction(async (tx) => {
      // Serialize creation within a workspace to enforce concurrent limits and idempotency.
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        workspace,
      ]);
      const previous = await tx.query<Row>(
        "SELECT * FROM work_items WHERE workspace_id=$1 AND idempotency_key=$2",
        [workspace, key],
      );
      if (previous.rows[0]) {
        const row = previous.rows[0];
        if (row.requirements !== requirements || row.project_id !== project)
          throw new HttpError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "같은 요청 키를 다른 내용에 사용할 수 없습니다.",
          );
        return { run: toRun(row), replayed: true };
      }
      if (
        !(
          await tx.query(
            "SELECT id FROM projects WHERE workspace_id=$1 AND id=$2",
            [workspace, project],
          )
        ).rows.length
      )
        throw new HttpError(404, "NOT_FOUND", "프로젝트를 찾을 수 없습니다.");
      const { plan, hash } = executionPlan(
        requirements,
        humanWorkflow
          ? { clarification: "", feedback: "", revision: 0 }
          : undefined,
      );
      const result = await tx.query<Row>(
        `INSERT INTO work_items (id,workspace_id,project_id,requirements,state,idempotency_key,plan_hash,execution_plan,policy_version,human_workflow)
        VALUES ($1,$2,$3,$4,$10,$5,$6,$7,$8,$9) RETURNING *`,
        [
          randomUUID(),
          workspace,
          project,
          requirements,
          key,
          hash,
          JSON.stringify(plan),
          policyVersion,
          humanWorkflow,
          humanWorkflow ? "awaiting_input" : "awaiting_run_approval",
        ],
      );
      await event(tx, result.rows[0], workspace, "created");
      return { run: toRun(result.rows[0]), replayed: false };
    });
  }

  async approve(
    workspace: string,
    id: string,
    version: number,
    planHash: string,
    policy: string,
  ) {
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
      if (
        row.plan_hash !== planHash ||
        row.policy_version !== policy ||
        policy !== policyVersion
      )
        throw new HttpError(
          409,
          "PLAN_CONFLICT",
          "계획이나 정책이 변경됐습니다. 최신 내용을 다시 확인하세요.",
        );
      const existing = (
        await tx.query(
          "SELECT * FROM work_approvals WHERE work_id=$1 AND approved_version=$2",
          [id, version],
        )
      ).rows[0];
      if (
        existing &&
        Number(existing.approved_version) === version &&
        existing.plan_hash === planHash &&
        existing.policy_version === policy
      )
        return { run: toRun(row), replayed: true };
      if (row.version !== version)
        throw new HttpError(
          409,
          "VERSION_CONFLICT",
          "작업 상태가 변경됐습니다. 새로 확인해 주세요.",
        );
      if (row.state !== "awaiting_run_approval")
        throw new HttpError(
          409,
          "INVALID_STATE",
          "현재 작업은 실행 승인 대상이 아닙니다.",
        );
      const count = (
        await tx.query(
          "SELECT count(*)::int AS count FROM work_items WHERE workspace_id=$1 AND state IN ('queued','running','verifying','cancelling','awaiting_decision')",
          [workspace],
        )
      ).rows[0];
      if (Number(count.count) >= 3)
        throw new HttpError(
          429,
          "CONCURRENCY_LIMIT",
          "대기와 실행 중인 모의 작업은 3개까지 가능합니다.",
        );
      const approvalId = randomUUID();
      const identity = String(
        (
          await tx.query("SELECT identity FROM workspaces WHERE id=$1", [
            workspace,
          ])
        ).rows[0].identity,
      );
      await tx.query(
        "INSERT INTO work_approvals (id,work_id,workspace_id,approved_version,plan_hash,policy_version,approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [approvalId, id, workspace, version, planHash, policy, identity],
      );
      await tx.query(
        "INSERT INTO execution_jobs (work_id,workspace_id,approval_id,status) VALUES ($1,$2,$3,'pending') ON CONFLICT(work_id) DO UPDATE SET approval_id=EXCLUDED.approval_id,status='pending',lease_owner=NULL,lease_until=NULL,generation=execution_jobs.generation+1,attempts=0,resume_pending=false",
        [id, workspace, approvalId],
      );
      const result = await tx.query<Row>(
        "UPDATE work_items SET state='queued',version=version+1,attempt_count=0,human_history=human_history || $2::jsonb WHERE id=$1 RETURNING *",
        [
          id,
          JSON.stringify([
            {
              action: "approve_plan",
              text: "현재 계획을 확인하고 모의 실행을 승인했습니다.",
              at: new Date().toISOString(),
            },
          ]),
        ],
      );
      await event(tx, result.rows[0], workspace, "approved");
      return { run: toRun(result.rows[0]), replayed: false };
    });
  }

  async cancel(workspace: string, id: string, version: number) {
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
      if (row.version !== version)
        throw new HttpError(
          409,
          "VERSION_CONFLICT",
          "작업 상태가 변경됐습니다. 새로 확인해 주세요.",
        );
      if (["cancelled", "cancelling"].includes(row.state)) return toRun(row);
      if (["review_ready", "completed", "failed"].includes(row.state))
        throw new HttpError(
          409,
          "TERMINAL_STATE",
          "종료된 작업은 취소할 수 없습니다.",
        );
      const running = ["running", "verifying"].includes(row.state);
      if (!running)
        await tx.query(
          "UPDATE execution_jobs SET status='cancelled',lease_owner=NULL,lease_until=NULL WHERE work_id=$1",
          [id],
        );
      const result = await tx.query<Row>(
        "UPDATE work_items SET state=$2,version=version+1 WHERE id=$1 RETURNING *",
        [id, running ? "cancelling" : "cancelled"],
      );
      await event(
        tx,
        result.rows[0],
        workspace,
        running ? "cancel_requested" : "cancelled",
      );
      return toRun(result.rows[0]);
    });
  }

  async respond(
    workspace: string,
    id: string,
    version: number,
    action: string,
    text: string,
    key: string,
  ) {
    return respond(this.db, workspace, id, version, action, text, key);
  }

  async events(workspace: string, id: string, cursor: number) {
    await this.get(workspace, id);
    return (
      await this.db.query(
        "SELECT sequence,type,payload FROM work_events WHERE workspace_id=$1 AND work_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 100",
        [workspace, id, cursor],
      )
    ).rows;
  }

  async tick() {
    await this.queue.tick();
  }
}
