import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, openDatabase, type Database } from "./database";
import { Store } from "./store";
import type { Run } from "../src/factory";

let db: Database, store: Store, workspace: string, project: string;
beforeAll(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
}, 20000);
beforeEach(async () => {
  await db.query("TRUNCATE workspaces CASCADE");
  workspace = randomUUID();
  project = randomUUID();
  store = new Store(db, 0);
  await db.query("INSERT INTO workspaces VALUES ($1,$2)", [workspace, "owner"]);
  await db.query(
    "INSERT INTO projects (id,workspace_id,name) VALUES ($1,$2,$3)",
    [project, workspace, "대화형 작업"],
  );
});
afterAll(async () => {
  await db.close();
});
const create = async () =>
  (
    await store.create(
      workspace,
      project,
      "팀의 업무를 등록하고 진행 상태를 관리하는 웹 앱을 만들어 주세요.",
      randomUUID(),
    )
  ).run;
const response = async (
  run: Run,
  action: string,
  text = "",
  key = randomUUID(),
) =>
  (await store.respond(workspace, run.id, run.version!, action, text, key)).run;
const answer = (run: Run) =>
  response(
    run,
    "answer",
    "팀원이 업무를 등록하고 상태를 변경하면 완료입니다. 알림과 외부 연동은 제외합니다.",
  );
const approve = (run: Run) =>
  store.approve(
    workspace,
    run.id,
    run.version!,
    run.planHash!,
    run.policyVersion!,
  );
async function pauseAtDecision(run: Run) {
  await approve(run);
  await store.tick();
  await store.tick();
  return store.get(workspace, run.id);
}
async function review(run: Run) {
  await response(run, "continue");
  await store.tick();
  await store.tick();
  return store.get(workspace, run.id);
}

it("holds every human checkpoint, releases its lease and requires an explicit final acceptance", async () => {
  let run = await create();
  for (let i = 0; i < 10; i++) await store.tick();
  expect(await store.get(workspace, run.id)).toMatchObject({
    state: "awaiting_input",
    stage: 0,
    version: 1,
  });
  await expect(approve(run)).rejects.toMatchObject({ code: "INVALID_STATE" });
  const originalHash = run.planHash;
  run = await answer(run);
  expect(run.state).toBe("awaiting_run_approval");
  expect(run.planHash).not.toBe(originalHash);
  expect(run.plan?.human?.clarification).toContain("외부 연동은 제외");
  for (let i = 0; i < 5; i++) await store.tick();
  expect((await store.get(workspace, run.id)).version).toBe(run.version);
  run = await pauseAtDecision(run);
  expect(run).toMatchObject({
    state: "awaiting_decision",
    stage: 2,
    attemptCount: 1,
  });
  const job = (
    await db.query("SELECT * FROM execution_jobs WHERE work_id=$1", [run.id])
  ).rows[0];
  expect(job).toMatchObject({
    status: "waiting",
    lease_owner: null,
    lease_until: null,
  });
  for (let i = 0; i < 10; i++) await new Store(db, 0).tick();
  expect((await store.get(workspace, run.id)).version).toBe(run.version);
  run = await review(run);
  expect(run).toMatchObject({ state: "review_ready", attemptCount: 1 });
  for (let i = 0; i < 5; i++) await store.tick();
  expect((await store.get(workspace, run.id)).state).toBe("review_ready");
  run = await response(run, "accept");
  expect(run.state).toBe("completed");
  expect(run.humanHistory?.map((item) => item.action)).toEqual([
    "answer",
    "approve_plan",
    "continue",
    "accept",
  ]);
});

it("revises before execution and after results, invalidating earlier approvals and retaining feedback", async () => {
  const first = await answer(await create());
  const edited = await response(
    first,
    "revise",
    "마감일 필터를 이번 작업의 완료 조건에 추가해 주세요.",
  );
  expect(edited.planHash).not.toBe(first.planHash);
  await expect(approve(first)).rejects.toMatchObject({ code: "PLAN_CONFLICT" });
  let run = await review(await pauseAtDecision(edited));
  const oldHash = run.planHash;
  run = await response(
    run,
    "revise",
    "마감일 필터의 빈 결과 안내를 추가해 주세요.",
  );
  expect(run).toMatchObject({
    state: "awaiting_run_approval",
    stage: 0,
    revision: 2,
    decision: "",
  });
  expect(run.planHash).not.toBe(oldHash);
  expect(run.plan?.human?.feedback).toContain("빈 결과");
  expect(
    (await db.query("SELECT status FROM execution_jobs")).rows[0].status,
  ).toBe("cancelled");
  for (let i = 0; i < 5; i++) await store.tick();
  expect((await store.get(workspace, run.id)).state).toBe(
    "awaiting_run_approval",
  );
  run = await review(await pauseAtDecision(run));
  expect(run.attemptCount).toBe(1);
  expect((await db.query("SELECT * FROM work_approvals")).rows).toHaveLength(2);
  expect(
    run.humanHistory?.filter((item) => item.action === "revise"),
  ).toHaveLength(2);
});

it("fences a paused worker and requires reapproval when the user changes scope at the decision point", async () => {
  const run = await answer(await create());
  await approve(run);
  const [lease] = await store.queue.claim();
  await store.queue.advance(lease);
  await store.queue.advance(lease);
  const paused = await store.get(workspace, run.id);
  expect(paused.state).toBe("awaiting_decision");
  expect(await store.queue.advance(lease)).toBe(false);
  const revised = await response(
    paused,
    "revise",
    "새로운 외부 연동은 제외하고 목록 조회만 구현해 주세요.",
  );
  await expect(approve(run)).rejects.toMatchObject({ code: "PLAN_CONFLICT" });
  expect(await store.queue.claim()).toEqual([]);
  await approve(revised);
  const [fresh] = await store.queue.claim();
  expect(fresh.generation).toBeGreaterThan(lease.generation);
  expect(await store.queue.advance(lease)).toBe(false);
});

it("replays concurrent responses once, rejects stale/invalid submissions and isolates workspaces", async () => {
  const run = await create(),
    key = randomUUID();
  const text = "팀원이 업무를 등록하면 완료입니다. 외부 연동은 제외합니다.";
  const replies = await Promise.all([
    store.respond(workspace, run.id, run.version!, "answer", text, key),
    store.respond(workspace, run.id, run.version!, "answer", text, key),
  ]);
  expect(replies.filter((item) => item.replayed)).toHaveLength(1);
  expect(replies[1].run.humanHistory).toHaveLength(1);
  await expect(
    store.respond(
      workspace,
      run.id,
      run.version!,
      "answer",
      "다른 답변을 같은 키로 저장하려고 합니다.",
      key,
    ),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(response(run, "answer", text)).rejects.toMatchObject({
    code: "VERSION_CONFLICT",
  });
  await expect(
    store.respond(
      randomUUID(),
      run.id,
      run.version!,
      "answer",
      text,
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(response(replies[0].run, "accept")).rejects.toMatchObject({
    code: "INVALID_STATE",
  });
  await expect(response(replies[0].run, "revise", "   ")).rejects.toMatchObject(
    { code: "INVALID_INPUT" },
  );
  expect(
    (await store.events(workspace, run.id, 0)).map((item) => item.sequence),
  ).toEqual([1, 2]);
});

it("cancels at a human pause without requeueing and bounds manually requested revisions", async () => {
  const paused = await pauseAtDecision(await answer(await create()));
  expect(
    (await store.cancel(workspace, paused.id, paused.version!)).state,
  ).toBe("cancelled");
  await expect(response(paused, "continue")).rejects.toMatchObject({
    code: "VERSION_CONFLICT",
  });
  expect(await store.queue.claim()).toEqual([]);
  let run = await answer(await create());
  for (let i = 0; i < 3; i++)
    run = await response(
      run,
      "revise",
      `완료 조건의 ${i + 1}번째 항목을 구체적으로 확인해 주세요.`,
    );
  await expect(
    response(run, "revise", "네 번째 수정도 자동으로 진행하려고 합니다."),
  ).rejects.toMatchObject({ code: "REVISION_LIMIT" });
});

it("frees the execution slot at a checkpoint but includes waiting approvals in the admission limit", async () => {
  const runs: Run[] = [];
  for (let i = 0; i < 4; i++) runs.push(await answer(await create()));
  for (const run of runs.slice(0, 3)) await approve(run);
  for (let i = 0; i < 6; i++) await store.tick();
  expect(
    (await store.list(workspace)).filter(
      (run) => run.state === "awaiting_decision",
    ),
  ).toHaveLength(3);
  expect(
    (await db.query("SELECT * FROM execution_jobs WHERE status='running'"))
      .rows,
  ).toHaveLength(0);
  await expect(approve(runs[3])).rejects.toMatchObject({
    code: "CONCURRENCY_LIMIT",
  });
  const paused = await store.get(workspace, runs[0].id);
  await store.cancel(workspace, paused.id, paused.version!);
  expect((await approve(runs[3])).run.state).toBe("queued");
});
