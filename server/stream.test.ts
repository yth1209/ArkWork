import { expect, it } from "vitest";
import { openDatabase, migrate } from "./database";
import { buildApp } from "./app";

it("serves resumed SSE events and closes an open stream on logout", async () => {
  const db = await openDatabase(":memory:");
  await migrate(db);
  const { app, store } = buildApp(db, { devAuth: true, intervalMs: 0 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const login = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      headers: { "x-arkwork-request": "browser" },
      payload: { identity: "owner" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const session = (
      await app.inject({ url: "/v1/session", headers: { cookie } })
    ).json();
    const project = (await store.projects(session.workspaceId))[0];
    const { run } = await store.create(
      session.workspaceId,
      String(project.id),
      "서버 이벤트를 다시 연결하고 로그아웃하면 연결을 닫아 주세요.",
      "stream-test-key",
      false,
    );
    await store.approve(
      session.workspaceId,
      run.id,
      run.version!,
      run.planHash!,
      run.policyVersion!,
    );
    await store.tick();
    await store.tick();
    const response = await fetch(`${base}/v1/work-items/${run.id}/events`, {
      headers: { cookie, "last-event-id": "1" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let data = "";
    while (!data.includes("id: 3")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      data += new TextDecoder().decode(chunk.value);
    }
    expect(data).toContain("id: 2");
    expect(data).not.toContain("id: 1");
    expect(data).toContain("event: work");
    await app.inject({
      method: "POST",
      url: "/v1/logout",
      headers: { cookie, "x-arkwork-request": "browser" },
    });
    let done = false;
    while (!done) done = (await reader.read()).done;
    expect(done).toBe(true);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await app.close();
    await db.close();
  }
}, 20000);
