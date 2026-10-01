import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "./database";
import { event, type Row } from "./work";
import { executionPlan, hashPlan, policyVersion } from "./plans";

export type Lease = {
  workId: string;
  workspace: string;
  owner: string;
  generation: number;
};

export class FixtureQueue {
  readonly owner = randomUUID();
  constructor(
    private db: Database,
    private intervalMs = 1800,
    private leaseMs = 5000,
  ) {}

  private async transition(
    tx: Queryable,
    row: Row,
    state: string,
    type: string,
    reason?: string,
  ) {
    const result = await tx.query<Row>(
      "UPDATE work_items SET state=$2,version=version+1,failure_reason=$3 WHERE id=$1 RETURNING *",
      [row.id, state, reason ?? null],
    );
    await event(tx, result.rows[0], row.workspace_id, type);
  }

  private async hasApproval(tx: Queryable, row: Row) {
    const approval = (
      await tx.query(
        `SELECT a.* FROM work_approvals a JOIN execution_jobs j ON j.approval_id=a.id
      WHERE j.work_id=$1 AND a.work_id=j.work_id AND a.workspace_id=j.workspace_id`,
        [row.id],
      )
    ).rows[0];
    return Boolean(
      approval &&
      approval.plan_hash === row.plan_hash &&
      approval.policy_version === policyVersion &&
      row.policy_version === policyVersion &&
      executionPlan(row.requirements).hash === row.plan_hash &&
      hashPlan(row.execution_plan) === row.plan_hash,
    );
  }

  async claim(): Promise<Lease[]> {
    return this.db.transaction(async (tx) => {
      // Workspace -> work -> job is the common lock order for admission and execution.
      const spaces = await tx.query(`SELECT id FROM workspaces WHERE EXISTS (
        SELECT 1 FROM execution_jobs j WHERE j.workspace_id=workspaces.id AND
        (j.status='pending' OR (j.status='running' AND j.lease_until<=now()))) ORDER BY id FOR UPDATE SKIP LOCKED`);
      const leases: Lease[] = [];
      for (const space of spaces.rows) {
        const workspace = String(space.id);
        const expired = await tx.query<Row>(
          `SELECT w.* FROM work_items w JOIN execution_jobs j ON j.work_id=w.id
          WHERE w.workspace_id=$1 AND j.status='running' AND j.lease_until<=now() ORDER BY w.id FOR UPDATE OF w`,
          [workspace],
        );
        for (const row of expired.rows) {
          const job = (
            await tx.query(
              "SELECT * FROM execution_jobs WHERE work_id=$1 FOR UPDATE",
              [row.id],
            )
          ).rows[0];
          const cancelled = row.state === "cancelling";
          const failed = Number(job.attempts) >= 2;
          await tx.query(
            "UPDATE execution_jobs SET status=$2,lease_owner=NULL,lease_until=NULL WHERE work_id=$1",
            [row.id, cancelled ? "cancelled" : failed ? "failed" : "pending"],
          );
          await this.transition(
            tx,
            row,
            cancelled ? "cancelled" : failed ? "failed" : "queued",
            cancelled ? "cancelled" : failed ? "failed" : "lease_recovered",
            failed && !cancelled
              ? "실행 권한이 반복해서 만료되어 자동 재시도 한도에 도달했습니다."
              : undefined,
          );
        }
        if (
          (
            await tx.query(
              "SELECT work_id FROM execution_jobs WHERE workspace_id=$1 AND status='running'",
              [workspace],
            )
          ).rows.length
        )
          continue;
        const candidates = await tx.query<Row>(
          `SELECT w.* FROM work_items w JOIN execution_jobs j ON j.work_id=w.id
          WHERE w.workspace_id=$1 AND w.state='queued' AND j.status='pending' ORDER BY j.created_at,w.id LIMIT 1 FOR UPDATE OF w`,
          [workspace],
        );
        const row = candidates.rows[0];
        if (!row) continue;
        if (!(await this.hasApproval(tx, row))) {
          await tx.query(
            "UPDATE execution_jobs SET status='failed' WHERE work_id=$1",
            [row.id],
          );
          await this.transition(
            tx,
            row,
            "failed",
            "approval_invalid",
            "승인한 계획과 현재 계획이 일치하지 않아 실행하지 않았습니다.",
          );
          continue;
        }
        const job = (
          await tx.query(
            `UPDATE execution_jobs SET status='running',lease_owner=$2,
          lease_until=now()+$3*interval '1 millisecond',generation=generation+1,attempts=attempts+1
          WHERE work_id=$1 AND status='pending' RETURNING *`,
            [row.id, this.owner, this.leaseMs],
          )
        ).rows[0];
        if (!job) continue;
        const updated = await tx.query<Row>(
          `UPDATE work_items SET state='running',version=version+1,attempt_count=attempt_count+1,
          next_step_at=now()+$2*interval '1 millisecond' WHERE id=$1 RETURNING *`,
          [row.id, this.intervalMs],
        );
        await event(tx, updated.rows[0], workspace, "started");
        leases.push({
          workId: row.id,
          workspace,
          owner: this.owner,
          generation: Number(job.generation),
        });
      }
      return leases;
    });
  }

  async advance(lease: Lease): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        lease.workspace,
      ]);
      const work = (
        await tx.query<Row>(
          "SELECT * FROM work_items WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
          [lease.workId, lease.workspace],
        )
      ).rows[0];
      if (!work) return false;
      const job = (
        await tx.query(
          `SELECT * FROM execution_jobs WHERE work_id=$1 AND status='running'
        AND lease_owner=$2 AND generation=$3 AND lease_until>now() FOR UPDATE`,
          [lease.workId, lease.owner, lease.generation],
        )
      ).rows[0];
      if (!job || lease.owner !== this.owner) return false;
      if (work.state === "cancelling") {
        await tx.query(
          "UPDATE execution_jobs SET status='cancelled',lease_owner=NULL,lease_until=NULL WHERE work_id=$1",
          [work.id],
        );
        await this.transition(tx, work, "cancelled", "cancelled");
        return true;
      }
      if (!["running", "verifying"].includes(work.state)) return false;
      if (!(await this.hasApproval(tx, work))) {
        await tx.query(
          "UPDATE execution_jobs SET status='failed',lease_owner=NULL,lease_until=NULL WHERE work_id=$1",
          [work.id],
        );
        await this.transition(
          tx,
          work,
          "failed",
          "approval_invalid",
          "승인한 계획과 현재 계획이 일치하지 않아 진행을 중단했습니다.",
        );
        return false;
      }
      await tx.query(
        "UPDATE execution_jobs SET lease_until=now()+$2*interval '1 millisecond' WHERE work_id=$1",
        [work.id, this.leaseMs],
      );
      const due = await tx.query(
        "SELECT id FROM work_items WHERE id=$1 AND next_step_at<=now()",
        [work.id],
      );
      if (!due.rows.length) return true;
      const stage = Math.min(work.stage + 1, 4);
      const state =
        stage === 4 ? "review_ready" : stage === 3 ? "verifying" : "running";
      const updated = await tx.query<Row>(
        `UPDATE work_items SET stage=$2,state=$3,version=version+1,
        next_step_at=now()+$4*interval '1 millisecond' WHERE id=$1 RETURNING *`,
        [work.id, stage, state, this.intervalMs],
      );
      await event(
        tx,
        updated.rows[0],
        lease.workspace,
        stage === 4 ? "completed" : "progress",
      );
      if (stage === 4)
        await tx.query(
          "UPDATE execution_jobs SET status='succeeded',lease_owner=NULL,lease_until=NULL WHERE work_id=$1",
          [work.id],
        );
      return true;
    });
  }

  async tick() {
    await this.claim();
    const jobs = await this.db.query(
      "SELECT work_id,workspace_id,generation FROM execution_jobs WHERE status='running' AND lease_owner=$1",
      [this.owner],
    );
    for (const job of jobs.rows)
      await this.advance({
        workId: String(job.work_id),
        workspace: String(job.workspace_id),
        owner: this.owner,
        generation: Number(job.generation),
      });
  }
}
