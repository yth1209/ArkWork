import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, migrate, type Database } from "./database";
import { Store } from "./store";
import { hashPlan } from "./plans";
import { randomUUID } from "node:crypto";

describe("approval and durable fixture queue", () => {
  let db: Database;
  let store: Store;
  let workspace: string;
  let project: string;
  beforeAll(async () => {
    db = await openDatabase(":memory:");
    await migrate(db);
  }, 20000);
  beforeEach(async () => {
    await db.query(
      "TRUNCATE work_events,execution_jobs,work_approvals,work_items,projects,sessions,workspaces CASCADE",
    );
    workspace = randomUUID();
    project = randomUUID();
    store = new Store(db, 0);
    await db.query("INSERT INTO workspaces VALUES ($1,$2)", [
      workspace,
      "owner",
    ]);
    await db.query(
      "INSERT INTO projects (id,workspace_id,name) VALUES ($1,$2,$3)",
      [project, workspace, "테스트"],
    );
  });
  afterAll(async () => {
    await db.close();
  });
  const create = () =>
    store.create(
      workspace,
      project,
      "승인한 계획에 대해서만 모의 작업을 실행해 주세요.",
      randomUUID(),
      false, // Legacy queue regression; interactive checkpoints have separate tests.
    );
  const approve = (run: Awaited<ReturnType<Store["get"]>>) =>
    store.approve(
      workspace,
      run.id,
      run.version!,
      run.planHash!,
      run.policyVersion!,
    );

  it("does not execute before approval and binds a stable hash to requirements, policy and limits", async () => {
    const { run } = await create();
    for (let i = 0; i < 5; i++) await store.tick();
    expect(await store.get(workspace, run.id)).toMatchObject({
      state: "awaiting_run_approval",
      stage: 0,
      version: 1,
    });
    expect((await db.query("SELECT * FROM execution_jobs")).rows).toHaveLength(
      0,
    );
    expect(hashPlan(run.plan)).toBe(run.planHash);
    expect(
      hashPlan({ ...run.plan, limits: { maxSteps: 4, maxAttempts: 9 } }),
    ).not.toBe(run.planHash);
    await expect(
      store.approve(workspace, run.id, 1, "a".repeat(64), run.policyVersion!),
    ).rejects.toMatchObject({ code: "PLAN_CONFLICT" });
    await expect(
      store.approve(workspace, run.id, 1, run.planHash!, "outdated"),
    ).rejects.toMatchObject({ code: "PLAN_CONFLICT" });
    await expect(
      store.approve(workspace, run.id, 9, run.planHash!, run.policyVersion!),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("stores one approval and queue entry on concurrent retries", async () => {
    const { run } = await create();
    const results = await Promise.all([
      approve(run),
      approve(run),
      approve(run),
    ]);
    expect(results.filter((result) => result.replayed)).toHaveLength(2);
    expect((await db.query("SELECT * FROM work_approvals")).rows).toHaveLength(
      1,
    );
    expect((await db.query("SELECT * FROM execution_jobs")).rows).toHaveLength(
      1,
    );
    expect(
      (await store.events(workspace, run.id, 0)).map((item) => item.type),
    ).toEqual(["created", "approved"]);
    await expect(
      store.approve(randomUUID(), run.id, 1, run.planHash!, run.policyVersion!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("admits one execution per workspace and rejects a second worker claim", async () => {
    const first = (await create()).run;
    const second = (await create()).run;
    await approve(first);
    await approve(second);
    const other = new Store(db, 0);
    const [a, b] = await Promise.all([
      store.queue.claim(),
      other.queue.claim(),
    ]);
    expect(a.length + b.length).toBe(1);
    expect(
      (await db.query("SELECT * FROM execution_jobs WHERE status='running'"))
        .rows,
    ).toHaveLength(1);
    expect(
      (await db.query("SELECT * FROM execution_jobs WHERE status='pending'"))
        .rows,
    ).toHaveLength(1);
  });

  it("fences a stale worker after lease recovery and bounds automatic attempts", async () => {
    const { run } = await create();
    await approve(run);
    const [oldLease] = await store.queue.claim();
    await db.query(
      "UPDATE execution_jobs SET lease_until=now()-interval '1 second'",
    );
    const replacement = new Store(db, 0);
    const [newLease] = await replacement.queue.claim();
    expect(newLease.generation).toBe(oldLease.generation + 1);
    expect(await store.queue.advance(oldLease)).toBe(false);
    expect(await replacement.queue.advance(newLease)).toBe(true);
    await db.query(
      "UPDATE execution_jobs SET lease_until=now()-interval '1 second'",
    );
    expect(await store.queue.claim()).toEqual([]);
    expect(await store.get(workspace, run.id)).toMatchObject({
      state: "failed",
      attemptCount: 2,
    });
    expect(
      (await db.query("SELECT status FROM execution_jobs")).rows[0].status,
    ).toBe("failed");
  });

  it("confirms cancellation through the worker or expired lease, and never requeues it", async () => {
    const { run } = await create();
    await approve(run);
    const [lease] = await store.queue.claim();
    const running = await store.get(workspace, run.id);
    expect(
      (await store.cancel(workspace, run.id, running.version!)).state,
    ).toBe("cancelling");
    await db.query(
      "UPDATE execution_jobs SET lease_until=now()-interval '1 second'",
    );
    expect(await new Store(db, 0).queue.claim()).toEqual([]);
    expect(await store.queue.advance(lease)).toBe(false);
    expect(await store.get(workspace, run.id)).toMatchObject({
      state: "cancelled",
      stage: 0,
    });
    expect(
      (await db.query("SELECT status FROM execution_jobs")).rows[0].status,
    ).toBe("cancelled");
  });

  it("cancels before execution without creating or starting a job", async () => {
    const { run } = await create();
    expect((await store.cancel(workspace, run.id, run.version!)).state).toBe(
      "cancelled",
    );
    await expect(approve(run)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    expect((await db.query("SELECT * FROM execution_jobs")).rows).toHaveLength(
      0,
    );
    const queued = (await create()).run;
    await approve(queued);
    const item = await store.get(workspace, queued.id);
    await store.cancel(workspace, item.id, item.version!);
    expect(await store.queue.claim()).toEqual([]);
  });

  it("fails closed when a queued plan is changed after approval", async () => {
    const { run } = await create();
    await approve(run);
    await db.query("UPDATE work_items SET requirements=$2 WHERE id=$1", [
      run.id,
      "승인하지 않은 다른 요구사항으로 실행 범위를 변경합니다.",
    ]);
    expect(await store.queue.claim()).toEqual([]);
    expect(await store.get(workspace, run.id)).toMatchObject({
      state: "failed",
      stage: 0,
      attemptCount: 0,
    });
  });
  it("stops an active lease when the approved plan or linked approval changes", async () => {
    const { run } = await create();
    await approve(run);
    const [lease] = await store.queue.claim();
    await db.query("UPDATE work_items SET execution_plan=$2 WHERE id=$1", [
      run.id,
      JSON.stringify({ ...run.plan, scope: "승인하지 않은 범위" }),
    ]);
    expect(await store.queue.advance(lease)).toBe(false);
    expect(await store.get(workspace, run.id)).toMatchObject({
      state: "failed",
      stage: 0,
    });
    expect(
      (await db.query("SELECT status FROM execution_jobs")).rows[0].status,
    ).toBe("failed");
  });
});
