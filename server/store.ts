import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "./database";
import type { Run } from "../src/factory";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Row = Record<string, unknown> & {
  id: string;
  requirements: string;
  state: string;
  stage: number;
  version: number;
  created_at: Date | string;
};
export function toRun(row: Row): Run {
  return {
    id: row.id,
    prompt: row.requirements,
    stage: row.stage,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    state: row.state,
    status:
      row.state === "cancelled"
        ? "cancelled"
        : row.state === "review_ready"
          ? "review"
          : "running",
  };
}

async function event(tx: Queryable, row: Row, workspace: string, type: string) {
  await tx.query(
    "INSERT INTO work_events (work_id, sequence, workspace_id, type, payload) VALUES ($1,$2,$3,$4,$5)",
    [row.id, row.version, workspace, type, JSON.stringify(toRun(row))],
  );
}

export class Store {
  constructor(
    public db: Database,
    private intervalMs = 1800,
  ) {}

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
      const count = await tx.query(
        "SELECT count(*)::int AS count FROM work_items WHERE workspace_id=$1 AND state IN ('received','running','verifying')",
        [workspace],
      );
      if (Number(count.rows[0].count) >= 3)
        throw new HttpError(
          429,
          "CONCURRENCY_LIMIT",
          "동시 모의 작업은 3개까지 가능합니다.",
        );
      const result = await tx.query<Row>(
        `INSERT INTO work_items (id,workspace_id,project_id,requirements,state,idempotency_key,next_step_at)
        VALUES ($1,$2,$3,$4,'received',$5,now()+$6*interval '1 millisecond') RETURNING *`,
        [randomUUID(), workspace, project, requirements, key, this.intervalMs],
      );
      await event(tx, result.rows[0], workspace, "created");
      return { run: toRun(result.rows[0]), replayed: false };
    });
  }

  async cancel(workspace: string, id: string, version: number) {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<Row>(
        "SELECT * FROM work_items WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [workspace, id],
      );
      const row = rows[0];
      if (!row)
        throw new HttpError(404, "NOT_FOUND", "작업을 찾을 수 없습니다.");
      if (row.version !== version)
        throw new HttpError(
          409,
          "VERSION_CONFLICT",
          "작업 상태가 변경됐습니다. 새로 확인해 주세요.",
        );
      if (row.state === "cancelled") return toRun(row);
      if (row.state === "review_ready")
        throw new HttpError(
          409,
          "TERMINAL_STATE",
          "완료된 작업은 취소할 수 없습니다.",
        );
      const result = await tx.query<Row>(
        "UPDATE work_items SET state='cancelled',version=version+1 WHERE id=$1 RETURNING *",
        [id],
      );
      await event(tx, result.rows[0], workspace, "cancelled");
      return toRun(result.rows[0]);
    });
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
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<Row>(
        "SELECT * FROM work_items WHERE state IN ('received','running','verifying') AND next_step_at<=now() FOR UPDATE SKIP LOCKED",
      );
      for (const row of rows) {
        const stage = Math.min(row.stage + 1, 4);
        const state =
          stage === 4 ? "review_ready" : stage === 3 ? "verifying" : "running";
        const result = await tx.query<Row>(
          `UPDATE work_items SET stage=$2,state=$3,version=version+1,next_step_at=now()+$4*interval '1 millisecond' WHERE id=$1 RETURNING *`,
          [row.id, stage, state, this.intervalMs],
        );
        await event(tx, result.rows[0], String(row.workspace_id), "progress");
      }
    });
  }
}
