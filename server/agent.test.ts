import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { openDatabase, migrate, type Database } from "./database";
import { Store } from "./store";
import { AgentService } from "./agent";
import { AgentError, type AgentProvider, type AgentResult } from "./codex";
import { hashPlan } from "./plans";
import { buildApp } from "./app";

let db: Database,
  store: Store,
  agent: AgentService,
  workspace: string,
  project: string;
const output = {
  summary: "팀 업무 관리 명세",
  acceptanceCriteria: ["담당자가 업무 상태를 변경할 수 있다."],
  excludedScope: ["외부 알림 연동"],
};
let provider: AgentProvider;
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
    [project, workspace, "Codex 테스트"],
  );
  provider = {
    status: vi.fn(async () => ({
      enabled: true,
      authenticated: true,
      authMode: "chatgpt-subscription" as const,
      message: "테스트 구독",
    })),
    run: vi.fn(async (phase) => ({
      output: phase === "questions" ? ["어떤 담당자가 사용하나요?"] : output,
      threadId: "test-thread",
      usage: { input_tokens: 123, output_tokens: 45 },
    })),
  };
  agent = new AgentService(db, provider);
});
afterAll(async () => {
  await db.close();
});
const create = async () =>
  (
    await store.create(
      workspace,
      project,
      "팀의 업무를 등록하고 담당자를 지정하는 앱을 만들어 주세요.",
      randomUUID(),
    )
  ).run;
const answer = async () => {
  const run = await create();
  return (
    await store.respond(
      workspace,
      run.id,
      run.version!,
      "answer",
      "팀원이 업무를 등록하고 상태를 변경하면 완료입니다. 알림은 제외합니다.",
      randomUUID(),
    )
  ).run;
};
const finish = async () => {
  await agent.tick();
  await agent.drain();
};
function delayed() {
  let resolve!: (result: AgentResult) => void;
  const pending = new Promise<AgentResult>((done) => {
    resolve = done;
  });
  provider.run = vi.fn(async (_phase, _input, signal) => {
    signal.throwIfAborted();
    return new Promise<AgentResult>((done, fail) => {
      signal.addEventListener(
        "abort",
        () => fail(new AgentError("ABORTED", "cancelled")),
        { once: true },
      );
      pending.then(done, fail);
    });
  });
  return resolve;
}

it("requires explicit authenticated subscription action and does not call on creation or missing login", async () => {
  const run = await create();
  await finish();
  expect(provider.run).not.toHaveBeenCalled();
  provider.status = vi.fn(async () => ({
    enabled: true,
    authenticated: false,
    authMode: "chatgpt-subscription" as const,
    message: "로그인 필요",
  }));
  await expect(
    agent.start(workspace, run.id, run.version!, "questions", randomUUID()),
  ).rejects.toMatchObject({ code: "CODEX_AUTH_REQUIRED" });
  expect((await db.query("SELECT * FROM agent_calls")).rows).toHaveLength(0);
});
it("deduplicates requests, generates questions and binds the generated specification into approval", async () => {
  const first = await create(),
    key = randomUUID();
  await agent.start(workspace, first.id, first.version!, "questions", key);
  expect(
    (await agent.start(workspace, first.id, first.version!, "questions", key))
      .replayed,
  ).toBe(true);
  await finish();
  let run = await store.get(workspace, first.id);
  expect(provider.run).toHaveBeenCalledTimes(1);
  expect(run.agentQuestions).toEqual(["어떤 담당자가 사용하나요?"]);
  run = (
    await store.respond(
      workspace,
      run.id,
      run.version!,
      "answer",
      "업무 담당자가 등록과 상태 변경을 사용합니다. 외부 연동은 제외합니다.",
      randomUUID(),
    )
  ).run;
  const before = run;
  await agent.start(
    workspace,
    run.id,
    run.version!,
    "specification",
    randomUUID(),
  );
  await finish();
  run = await store.get(workspace, run.id);
  expect(run.agentSpecification).toEqual(output);
  expect(run.plan?.human?.specification).toEqual(output);
  expect(run.planHash).toBe(hashPlan(run.plan));
  expect(run.planHash).not.toBe(before.planHash);
  await expect(
    store.approve(
      workspace,
      run.id,
      before.version!,
      before.planHash!,
      before.policyVersion!,
    ),
  ).rejects.toMatchObject({ code: "PLAN_CONFLICT" });
  expect(
    (
      await store.approve(
        workspace,
        run.id,
        run.version!,
        run.planHash!,
        run.policyVersion!,
      )
    ).run.state,
  ).toBe("queued");
  await store.tick();
  expect((await store.get(workspace, run.id)).status).toBe("running");
  const records = (
    await db.query(
      "SELECT actor,thread_id,usage FROM agent_calls ORDER BY created_at",
    )
  ).rows;
  expect(records).toHaveLength(2);
  expect(records[1]).toMatchObject({
    actor: "owner",
    thread_id: "test-thread",
    usage: { input_tokens: 123 },
  });
});
it("blocks edits while running, supports cancellation and drops a late result without advancing the human gate", async () => {
  const resolve = delayed(),
    run = await create();
  await agent.start(workspace, run.id, run.version!, "questions", randomUUID());
  await agent.tick();
  const running = await store.get(workspace, run.id);
  expect(running.agentTask?.status).toBe("running");
  await expect(
    store.respond(
      workspace,
      run.id,
      running.version!,
      "answer",
      "모델 실행 중에 범위를 바꾸려고 합니다.",
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: "AGENT_BUSY" });
  await agent.cancel(workspace, run.id);
  await agent.drain();
  resolve({ output: ["늦은 결과"], threadId: "late", usage: null });
  const cancelled = await store.get(workspace, run.id);
  expect(cancelled.agentTask?.status).toBe("cancelled");
  expect(cancelled.agentQuestions).toBeUndefined();
  expect(cancelled.state).toBe("awaiting_input");
});
it("does not retry after failure or restart and bounds explicit attempts to two", async () => {
  provider.run = vi.fn(async () => {
    throw new AgentError("CODEX_FAILED", "raw secret must not be stored");
  });
  let run = await create();
  for (let i = 0; i < 2; i++) {
    await agent.start(
      workspace,
      run.id,
      run.version!,
      "questions",
      randomUUID(),
    );
    await finish();
    run = await store.get(workspace, run.id);
  }
  await expect(
    agent.start(workspace, run.id, run.version!, "questions", randomUUID()),
  ).rejects.toMatchObject({ code: "AGENT_LIMIT" });
  for (let i = 0; i < 5; i++) await new AgentService(db, provider).tick();
  expect(provider.run).toHaveBeenCalledTimes(2);
  expect(
    JSON.stringify((await db.query("SELECT * FROM agent_calls")).rows),
  ).not.toContain("raw secret");
});
it("marks an expired crashed call failed and prevents a stale worker from publishing output", async () => {
  const resolve = delayed(),
    run = await create();
  await agent.start(workspace, run.id, run.version!, "questions", randomUUID());
  await agent.tick();
  await db.query("UPDATE agent_calls SET expires_at=now()-interval '1 second'");
  await new AgentService(db, provider).tick();
  resolve({ output: ["만료된 결과"], threadId: "expired", usage: null });
  await agent.drain();
  const restored = await store.get(workspace, run.id);
  expect(restored.agentTask).toMatchObject({
    status: "failed",
    errorCode: "INTERRUPTED",
  });
  expect(restored.agentQuestions).toBeUndefined();
  expect(provider.run).toHaveBeenCalledTimes(1);
});
it("blocks cross-workspace access and enforces owner-only subscription use", async () => {
  const run = await create();
  await expect(
    agent.start(randomUUID(), run.id, run.version!, "questions", randomUUID()),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await db.query("UPDATE workspaces SET identity='guest' WHERE id=$1", [
    workspace,
  ]);
  await expect(
    agent.start(workspace, run.id, run.version!, "questions", randomUUID()),
  ).rejects.toMatchObject({ code: "OWNER_ONLY" });
});
it("validates the HTTP generation contract and exposes only sanitized subscription status", async () => {
  const service = buildApp(db, { devAuth: true, agent: provider });
  try {
    const login = await service.app.inject({
      method: "POST",
      url: "/v1/dev/session",
      headers: { "x-arkwork-request": "browser" },
      payload: { identity: "owner" },
    });
    const headers = {
      cookie: String(login.headers["set-cookie"]).split(";")[0],
      "x-arkwork-request": "browser",
    };
    const run = await create();
    expect(
      (await service.app.inject({ url: "/v1/agent", headers })).json(),
    ).toMatchObject({ authMode: "chatgpt-subscription" });
    expect(
      (
        await service.app.inject({
          method: "POST",
          url: `/v1/work-items/${run.id}/codex`,
          headers,
          payload: {
            expected_version: run.version,
            phase: "implementation",
            request_key: randomUUID(),
          },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await service.app.inject({
          method: "POST",
          url: `/v1/work-items/${run.id}/codex`,
          headers,
          payload: {
            expected_version: run.version,
            phase: "questions",
            request_key: randomUUID(),
          },
        })
      ).statusCode,
    ).toBe(200);
    const cancel = await service.app.inject({
      method: "POST",
      url: `/v1/work-items/${run.id}/codex/cancel`,
      headers,
      payload: {},
    });
    expect(cancel.json().agentTask.status).toBe("cancelled");
    expect(provider.run).not.toHaveBeenCalled();
  } finally {
    await service.app.close();
  }
});

it("aborts a timed-out call and never consumes another attempt automatically", async () => {
  delayed();
  agent = new AgentService(db, provider, 20);
  const run = await create();
  await agent.start(workspace, run.id, run.version!, "questions", randomUUID());
  await finish();
  expect((await store.get(workspace, run.id)).agentTask).toMatchObject({
    status: "failed",
    errorCode: "TIMEOUT",
  });
  await agent.tick();
  expect(provider.run).toHaveBeenCalledTimes(1);
});
it("blocks approval during generation and requires a new generation or manual review after feedback", async () => {
  let run = await answer();
  await agent.start(
    workspace,
    run.id,
    run.version!,
    "specification",
    randomUUID(),
  );
  run = await store.get(workspace, run.id);
  await expect(
    store.approve(
      workspace,
      run.id,
      run.version!,
      run.planHash!,
      run.policyVersion!,
    ),
  ).rejects.toMatchObject({ code: "AGENT_BUSY" });
  await finish();
  run = await store.get(workspace, run.id);
  const oldHash = run.planHash;
  run = (
    await store.respond(
      workspace,
      run.id,
      run.version!,
      "revise",
      "알림은 제외하고 빈 결과 안내를 완료 조건으로 추가해 주세요.",
      randomUUID(),
    )
  ).run;
  expect(run.agentSpecification).toBeUndefined();
  expect(run.agentTask).toBeUndefined();
  expect(run.planHash).not.toBe(oldHash);
  await agent.start(
    workspace,
    run.id,
    run.version!,
    "specification",
    randomUUID(),
  );
  await finish();
  expect(provider.run).toHaveBeenCalledTimes(2);
});
