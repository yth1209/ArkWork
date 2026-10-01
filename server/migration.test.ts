import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { openDatabase, migrate } from "./database";

it("upgrades legacy fixtures without silently granting approval or changing completed history", async () => {
  const db = await openDatabase(":memory:");
  try {
    const sql = await readFile(
      new URL("./migrations/001-foundation.sql", import.meta.url),
      "utf8",
    );
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.query(statement);
    await db.query(
      "CREATE TABLE schema_migrations (name text PRIMARY KEY,checksum text NOT NULL)",
    );
    await db.query("INSERT INTO schema_migrations VALUES ($1,$2)", [
      "001-foundation",
      createHash("sha256").update(sql).digest("hex"),
    ]);
    const workspace = randomUUID(),
      project = randomUUID();
    await db.query("INSERT INTO workspaces VALUES ($1,$2)", [
      workspace,
      "owner",
    ]);
    await db.query(
      "INSERT INTO projects (id,workspace_id,name) VALUES ($1,$2,$3)",
      [project, workspace, "이전 프로젝트"],
    );
    const states = [
      "received",
      "running",
      "verifying",
      "review_ready",
      "cancelled",
    ];
    for (const state of states)
      await db.query(
        "INSERT INTO work_items (id,workspace_id,project_id,requirements,state,stage,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          workspace,
          project,
          "이전 버전의 작업과 검증된 결과를 보존해 주세요.",
          state,
          state === "review_ready" ? 4 : 2,
          state,
        ],
      );
    await migrate(db);
    await migrate(db);
    const rows = (
      await db.query("SELECT * FROM work_items ORDER BY idempotency_key")
    ).rows;
    const active = rows.filter((row) =>
      ["received", "running", "verifying"].includes(
        String(row.idempotency_key),
      ),
    );
    expect(active).toHaveLength(3);
    expect(
      active.every(
        (row) =>
          row.state === "awaiting_run_approval" &&
          row.stage === 0 &&
          row.version === 2 &&
          Boolean(row.plan_hash),
      ),
    ).toBe(true);
    expect(
      rows.find((row) => row.idempotency_key === "review_ready"),
    ).toMatchObject({ state: "review_ready", stage: 4, version: 1 });
    expect(
      rows.find((row) => row.idempotency_key === "cancelled"),
    ).toMatchObject({ state: "cancelled", version: 1 });
    expect((await db.query("SELECT * FROM work_events")).rows).toHaveLength(3);
    expect((await db.query("SELECT * FROM work_approvals")).rows).toHaveLength(
      0,
    );
    expect((await db.query("SELECT * FROM execution_jobs")).rows).toHaveLength(
      0,
    );
  } finally {
    await db.close();
  }
}, 20000);
