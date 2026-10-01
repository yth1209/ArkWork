import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { openDatabase, migrate, type Database } from "./database";
import { buildApp } from "./app";
import { PullRequests } from "./pullRequests";
import { HttpError, Store } from "./store";
import type { GitHubProvider, Snapshot } from "./github";
import type { Run } from "../src/factory";
let db: Database,
  workspace: string,
  project: string,
  store: Store,
  service: PullRequests,
  run: Run;
let snapshot: Snapshot, provider: GitHubProvider;
const target = {
  repository: "owner/repo",
  base: "main",
  branch: "factory/result",
};
const sha = "a".repeat(40);
beforeAll(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
}, 20000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.query("TRUNCATE workspaces CASCADE");
  workspace = randomUUID();
  project = randomUUID();
  await db.query("INSERT INTO workspaces VALUES ($1,'owner')", [workspace]);
  await db.query(
    "INSERT INTO projects (id,workspace_id,name) VALUES ($1,$2,'PR 검토')",
    [project, workspace],
  );
  store = new Store(db, 0);
  run = (
    await store.create(
      workspace,
      project,
      "팀의 업무 상태를 변경하는 앱을 만들어 주세요.",
      randomUUID(),
    )
  ).run;
  run = (
    await store.respond(
      workspace,
      run.id,
      run.version!,
      "answer",
      "팀원이 업무 상태를 변경하면 완료입니다.",
      randomUUID(),
    )
  ).run;
  run = (
    await store.approve(
      workspace,
      run.id,
      run.version!,
      run.planHash!,
      run.policyVersion!,
    )
  ).run;
  await store.tick();
  await store.tick();
  run = await store.get(workspace, run.id);
  run = (
    await store.respond(
      workspace,
      run.id,
      run.version!,
      "continue",
      "",
      randomUUID(),
    )
  ).run;
  await store.tick();
  await store.tick();
  run = await store.get(workspace, run.id);
  expect(run.state).toBe("review_ready");
  snapshot = {
    number: 12,
    url: "https://github.com/owner/repo/pull/12",
    headSha: sha,
    open: true,
    draft: false,
    checks: "passed",
    files: [{ path: "src/app.ts", additions: 20, deletions: 3 }],
    filesTruncated: false,
  };
  provider = {
    repositories: [target.repository],
    publish: vi.fn(async () => structuredClone(snapshot)),
    inspect: vi.fn(async () => structuredClone(snapshot)),
  };
  service = new PullRequests(db, provider);
});
const publish = () => service.publish(workspace, run.id, run.version!, target);
const assess = (decision: "approve" | "changes", key = randomUUID()) =>
  service.assess(
    workspace,
    run.id,
    run.version!,
    run.pullRequest!.headSha!,
    decision,
    "완료 조건과 변경 파일을 확인했습니다.",
    key,
  );
it("publishes once, survives service restart, records changes and requires a SHA-bound human approval", async () => {
  run = await publish();
  expect(run.pullRequest).toMatchObject({ ...snapshot, status: "ready" });
  run = await new PullRequests(db, provider).publish(
    workspace,
    run.id,
    1,
    target,
  );
  expect(provider.publish).toHaveBeenCalledTimes(1);
  await expect(
    store.respond(workspace, run.id, run.version!, "accept", "", randomUUID()),
  ).rejects.toMatchObject({ code: "PR_REVIEW_REQUIRED" });
  run = await assess("changes");
  expect(run.state).toBe("review_ready");
  expect(run.feedback).toContain("완료 조건");
  snapshot.headSha = "b".repeat(40);
  await expect(assess("approve")).rejects.toMatchObject({ code: "PR_CHANGED" });
  run = await store.get(workspace, run.id);
  expect(run.pullRequest?.assessment).toBeUndefined();
  expect(run.pullRequest?.reviews).toHaveLength(1);
  const key = randomUUID();
  const oldVersion = run.version!;
  run = await assess("approve", key);
  expect(run.state).toBe("completed");
  const replay = await service.assess(
    workspace,
    run.id,
    oldVersion,
    snapshot.headSha,
    "approve",
    "완료 조건과 변경 파일을 확인했습니다.",
    key,
  );
  expect(replay.pullRequest?.reviews).toHaveLength(2);
  snapshot.headSha = "c".repeat(40);
  run = await service.refresh(workspace, run.id, run.version!);
  expect(run.state).toBe("review_ready");
  expect(run.pullRequest?.assessment).toBeUndefined();
});
it("rejects unconfigured targets, cross-workspace access, stale versions and review before publication", async () => {
  await expect(
    new PullRequests(db).publish(workspace, run.id, run.version!, target),
  ).rejects.toMatchObject({ code: "GITHUB_DISABLED" });
  await expect(
    service.publish(workspace, run.id, run.version!, {
      ...target,
      repository: "other/repo",
    }),
  ).rejects.toMatchObject({ code: "REPOSITORY_DENIED" });
  await expect(
    service.publish(workspace, run.id, 1, target),
  ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(
    service.publish(randomUUID(), run.id, run.version!, target),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    service.publish(workspace, run.id, run.version!, {
      ...target,
      branch: "../main",
    }),
  ).rejects.toMatchObject({ code: "INVALID_TARGET" });
  await expect(
    service.assess(
      workspace,
      run.id,
      run.version!,
      sha,
      "approve",
      "변경 내용을 검토했습니다.",
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(provider.publish).not.toHaveBeenCalled();
});
it("reconciles an ambiguous remote failure after restart, but releases a definitively empty branch", async () => {
  vi.mocked(provider.publish).mockRejectedValueOnce(
    new HttpError(502, "GITHUB_UNAVAILABLE", "연결 실패"),
  );
  await expect(publish()).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  run = await store.get(workspace, run.id);
  expect(run.pullRequest?.status).toBe("publishing");
  await expect(
    service.publish(workspace, run.id, run.version!, {
      ...target,
      branch: "another",
    }),
  ).rejects.toMatchObject({ code: "PR_TARGET_LOCKED" });
  run = await new PullRequests(db, provider).publish(
    workspace,
    run.id,
    1,
    target,
  );
  expect(run.pullRequest?.number).toBe(12);
});
it("releases an empty submission so the owner can correct the implementation branch", async () => {
  vi.mocked(provider.publish).mockRejectedValueOnce(
    new HttpError(409, "NO_IMPLEMENTATION", "변경 없음"),
  );
  await expect(publish()).rejects.toMatchObject({ code: "NO_IMPLEMENTATION" });
  run = await store.get(workspace, run.id);
  expect(run.pullRequest).toBeUndefined();
  run = await publish();
  expect(run.pullRequest?.status).toBe("ready");
});
it.each(["pending", "failed"] as const)(
  "blocks approval with %s CI and invalidates earlier approval on refresh",
  async (checks) => {
    run = await publish();
    run = await assess("approve");
    snapshot.checks = checks;
    run = await service.refresh(workspace, run.id, run.version!);
    expect(run.state).toBe("review_ready");
    await expect(assess("approve")).rejects.toMatchObject({
      code: "PR_CHANGED",
    });
    run = await store.get(workspace, run.id);
    run = await assess("changes");
    expect(run.pullRequest?.assessment?.decision).toBe("changes");
  },
);
it.each([{ open: false }, { draft: true }])(
  "blocks approval for closed/draft PRs",
  async (change) => {
    run = await publish();
    Object.assign(snapshot, change);
    await expect(assess("approve")).rejects.toMatchObject({
      code: "PR_CHANGED",
    });
  },
);
it("exposes scoped routes, rejects arbitrary fields and never performs an implicit merge", async () => {
  const { app } = buildApp(db, { devAuth: true, github: provider });
  const session = await app.inject({
    method: "POST",
    url: "/v1/dev/session",
    headers: { "x-arkwork-request": "browser" },
    payload: { identity: "owner" },
  });
  const headers = {
    cookie: session.headers["set-cookie"] as string,
    "x-arkwork-request": "browser",
  };
  const status = await app.inject({ url: "/v1/publisher", headers });
  expect(status.json()).toEqual({
    enabled: true,
    repositories: ["owner/repo"],
  });
  const invalid = await app.inject({
    method: "POST",
    url: `/v1/work-items/${run.id}/pull-request`,
    headers,
    payload: { ...target, expected_version: run.version, merge: true },
  });
  expect(invalid.statusCode).toBe(422);
  const published = await app.inject({
    method: "POST",
    url: `/v1/work-items/${run.id}/pull-request`,
    headers,
    payload: { ...target, expected_version: run.version },
  });
  expect(published.statusCode).toBe(200);
  run = published.json();
  const evaluated = await app.inject({
    method: "POST",
    url: `/v1/work-items/${run.id}/pull-request/reviews`,
    headers,
    payload: {
      expected_version: run.version,
      head_sha: sha,
      decision: "approve",
      text: "変更ファイルと完了条件を確認しました。",
      request_key: randomUUID(),
    },
  });
  expect(evaluated.statusCode).toBe(200);
  expect(evaluated.json().state).toBe("completed");
  await app.close();
});

it("fences a delayed publication after its original reservation was released", async () => {
  let finish!: (value: Snapshot) => void;
  vi.mocked(provider.publish).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = publish();
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 5));
  vi.mocked(provider.publish).mockRejectedValueOnce(
    new HttpError(409, "NO_IMPLEMENTATION", "변경 없음"),
  );
  await expect(publish()).rejects.toMatchObject({ code: "NO_IMPLEMENTATION" });
  run = await store.get(workspace, run.id);
  run = await service.publish(workspace, run.id, run.version!, {
    ...target,
    branch: "factory/other",
  });
  finish({ ...snapshot, number: 99 });
  await expect(first).rejects.toMatchObject({ code: "SUBMISSION_CHANGED" });
  expect((await store.get(workspace, run.id)).pullRequest?.number).toBe(12);
});
it("invalidates an accepted result when GitHub changes the target repository or base", async () => {
  run = await publish();
  run = await assess("approve");
  vi.mocked(provider.inspect).mockRejectedValueOnce(
    new HttpError(409, "PR_TARGET_CHANGED", "대상 변경"),
  );
  await expect(
    service.refresh(workspace, run.id, run.version!),
  ).rejects.toMatchObject({ code: "PR_TARGET_CHANGED" });
  run = await store.get(workspace, run.id);
  expect(run.state).toBe("review_ready");
  expect(run.pullRequest?.assessment).toBeUndefined();
});
