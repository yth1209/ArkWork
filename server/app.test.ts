import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, migrate, type Database } from "./database";
import { buildApp } from "./app";
import { Store } from "./store";

describe("local control API with PostgreSQL engine", () => {
  let db: Database;
  let service: ReturnType<typeof buildApp>;
  let owner: string;
  let guest: string;
  let project: string;
  const protectedHeaders = (cookie = owner) => ({
    cookie,
    "x-arkwork-request": "browser",
  });
  beforeAll(async () => {
    db = await openDatabase(":memory:");
    await migrate(db);
    await migrate(db);
    service = buildApp(db, { devAuth: true, intervalMs: 0 });
    await service.app.ready();
  }, 20000);
  beforeEach(async () => {
    await db.query(
      "TRUNCATE work_events,work_items,projects,sessions,workspaces CASCADE",
    );
    for (const identity of ["owner", "guest"]) {
      const response = await service.app.inject({
        method: "POST",
        url: "/v1/dev/session",
        headers: { "x-arkwork-request": "browser" },
        payload: { identity },
      });
      expect(response.statusCode).toBe(200);
      const cookie = String(response.headers["set-cookie"]).split(";")[0];
      if (identity === "owner") owner = cookie;
      else guest = cookie;
    }
    const result = await service.app.inject({
      url: "/v1/projects",
      headers: { cookie: owner },
    });
    project = result.json().projects[0].id;
  });
  afterAll(async () => {
    await service?.app.close();
    await db?.close();
  });
  const create = (
    key = "test-key-123",
    requirements = "업무를 생성하고 담당자를 지정하는 앱을 만들어 주세요.",
  ) =>
    service.app.inject({
      method: "POST",
      url: `/v1/projects/${project}/work-items`,
      headers: { ...protectedHeaders(), "idempotency-key": key },
      payload: { requirements },
    });

  const approve = (
    run: {
      id: string;
      version: number;
      planHash: string;
      policyVersion: string;
    },
    cookie = owner,
  ) =>
    service.app.inject({
      method: "POST",
      url: `/v1/work-items/${run.id}/approvals`,
      headers: protectedHeaders(cookie),
      payload: {
        expected_version: run.version,
        plan_hash: run.planHash,
        policy_version: run.policyVersion,
      },
    });

  it("requires opt-in, sessions, request protection and same-origin", async () => {
    expect(() => buildApp(db, { devAuth: false })).toThrow();
    expect(
      (await service.app.inject({ url: "/v1/work-items" })).statusCode,
    ).toBe(401);
    expect(
      (
        await service.app.inject({
          method: "POST",
          url: "/v1/dev/session",
          payload: { identity: "owner" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await service.app.inject({
          url: "/v1/work-items",
          headers: { cookie: owner, origin: "https://evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await service.app.inject({
          url: "/health",
          headers: { host: "evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await service.app.inject({
          url: "/v1/work-items",
          headers: { cookie: "arkwork_session=" + "a".repeat(64) },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("validates approval payload, rejects other workspaces and replays the same HTTP approval", async () => {
    const run = (await create()).json().run;
    expect(
      (
        await service.app.inject({
          method: "POST",
          url: `/v1/work-items/${run.id}/approvals`,
          headers: protectedHeaders(),
          payload: { expected_version: 1 },
        })
      ).statusCode,
    ).toBe(422);
    expect((await approve(run, guest)).statusCode).toBe(404);
    const first = await approve(run),
      again = await approve(run);
    expect(first.statusCode).toBe(200);
    expect(first.json().run.state).toBe("queued");
    expect(again.json().replayed).toBe(true);
    expect((await db.query("SELECT * FROM execution_jobs")).rows).toHaveLength(
      1,
    );
  });
  it("validates input and project ownership", async () => {
    expect((await create("test-invalid", " ".repeat(10))).statusCode).toBe(422);
    expect((await create("test-invalid", "a".repeat(10001))).statusCode).toBe(
      422,
    );
    expect(
      (
        await service.app.inject({
          method: "POST",
          url: `/v1/projects/${project}/work-items`,
          headers: {
            ...protectedHeaders(guest),
            "idempotency-key": "test-other-123",
          },
          payload: {
            requirements: "다른 사람의 프로젝트에 접근하려는 요구사항입니다.",
          },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("creates one work item on concurrent retries and rejects key reuse with different input", async () => {
    const results = await Promise.all([create(), create(), create()]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([
      200, 200, 201,
    ]);
    expect(
      new Set(results.map((response) => response.json().run.id)).size,
    ).toBe(1);
    expect(
      (
        await create(
          "test-key-123",
          "기존 요청과 다른 요구사항을 저장해 주세요.",
        )
      ).statusCode,
    ).toBe(409);
    expect((await db.query("SELECT * FROM work_events")).rows).toHaveLength(1);
  });
  it("isolates work lists, item reads, event reads and cancellation by workspace", async () => {
    const run = (await create()).json().run;
    const response = await service.app.inject({
      url: "/v1/work-items",
      headers: { cookie: guest },
    });
    expect(response.json().runs).toEqual([]);
    for (const suffix of ["", "/events"])
      expect(
        (
          await service.app.inject({
            url: `/v1/work-items/${run.id}${suffix}`,
            headers: { cookie: guest },
          })
        ).statusCode,
      ).toBe(404);
    expect(
      (
        await service.app.inject({
          method: "POST",
          url: `/v1/work-items/${run.id}/cancel`,
          headers: protectedHeaders(guest),
          payload: { expected_version: 1 },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("rejects stale cancellation and never advances a cancelled item", async () => {
    const run = (await create()).json().run;
    expect((await approve(run)).statusCode).toBe(200);
    await service.store.tick();
    const stale = await service.app.inject({
      method: "POST",
      url: `/v1/work-items/${run.id}/cancel`,
      headers: protectedHeaders(),
      payload: { expected_version: 1 },
    });
    expect(stale.statusCode).toBe(409);
    const cancelled = await service.app.inject({
      method: "POST",
      url: `/v1/work-items/${run.id}/cancel`,
      headers: protectedHeaders(),
      payload: { expected_version: 4 },
    });
    expect(cancelled.json().status).toBe("cancelling");
    await service.store.tick();
    const result = await service.app.inject({
      url: `/v1/work-items/${run.id}`,
      headers: { cookie: owner },
    });
    expect(result.json()).toMatchObject({
      status: "cancelled",
      stage: 1,
      version: 6,
    });
  });
  it("limits approved work and preserves ordered events across worker creation", async () => {
    for (let i = 0; i < 3; i++) {
      const created = await create(`test-key-${i}`);
      expect(created.statusCode).toBe(201);
      expect((await approve(created.json().run)).statusCode).toBe(200);
    }
    const fourth = await create("test-fourth");
    expect(fourth.statusCode).toBe(201);
    expect((await approve(fourth.json().run)).statusCode).toBe(429);
    const identity = (
      await service.app.inject({
        url: "/v1/session",
        headers: { cookie: owner },
      })
    ).json().workspaceId;
    const restarted = new Store(db, 0);
    for (let i = 0; i < 12; i++) await restarted.tick();
    const runs = (await restarted.list(identity)).filter(
      (run) => run.id !== fourth.json().run.id,
    );
    expect(runs).toHaveLength(3);
    expect(
      runs.every((run) => run.state === "review_ready" && run.version === 7),
    ).toBe(true);
    const events = await restarted.events(identity, runs[0].id, 2);
    expect(events.map((item) => item.sequence)).toEqual([3, 4, 5, 6, 7]);
    expect((await approve(fourth.json().run)).statusCode).toBe(200);
  });
  it("does not leak SQL details and invalidates logout sessions", async () => {
    const response = await service.app.inject({
      method: "POST",
      url: "/v1/logout",
      headers: protectedHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(
      (
        await service.app.inject({
          url: "/v1/work-items",
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await service.app.inject({
          url: "/v1/work-items/not-a-uuid",
          headers: { cookie: guest },
        })
      ).statusCode,
    ).toBe(422);
  });
});
