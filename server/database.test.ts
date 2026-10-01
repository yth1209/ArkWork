import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase, migrate, type Database } from "./database";
import { buildApp } from "./app";

it("persists sessions, work and events across closing and reopening the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arkwork-db-test-"));
  let db: Database | undefined;
  let service: ReturnType<typeof buildApp> | undefined;
  try {
    db = await openDatabase(join(directory, "db"));
    await expect(openDatabase(join(directory, "db"))).rejects.toThrow();
    await migrate(db);
    service = buildApp(db, { devAuth: true, intervalMs: 0 });
    const login = await service.app.inject({
      method: "POST",
      url: "/v1/dev/session",
      headers: { "x-arkwork-request": "browser" },
      payload: { identity: "owner" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const projects = await service.app.inject({
      url: "/v1/projects",
      headers: { cookie },
    });
    const work = await service.app.inject({
      method: "POST",
      url: `/v1/projects/${projects.json().projects[0].id}/work-items`,
      headers: {
        cookie,
        "x-arkwork-request": "browser",
        "idempotency-key": "persistent-request",
      },
      payload: {
        requirements:
          "서버를 다시 시작해도 요구사항과 작업 기록을 유지해 주세요.",
      },
    });
    expect(work.statusCode).toBe(201);
    await service.store.tick();
    await service.app.close();
    service = undefined;
    await db.close();
    db = undefined;
    db = await openDatabase(join(directory, "db"));
    await migrate(db);
    service = buildApp(db, { devAuth: true, intervalMs: 0 });
    const list = await service.app.inject({
      url: "/v1/work-items",
      headers: { cookie },
    });
    expect(list.json().runs).toHaveLength(1);
    expect(list.json().runs[0]).toMatchObject({
      id: work.json().run.id,
      version: 2,
      stage: 1,
    });
    for (let i = 0; i < 3; i++) await service.store.tick();
    const result = await service.app.inject({
      url: `/v1/work-items/${work.json().run.id}`,
      headers: { cookie },
    });
    expect(result.json().status).toBe("review");
    expect((await db.query("SELECT * FROM work_events")).rows).toHaveLength(5);
    await db.query("UPDATE schema_migrations SET checksum='changed'");
    await expect(migrate(db)).rejects.toThrow("migration");
  } finally {
    await service?.app.close();
    await db?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
