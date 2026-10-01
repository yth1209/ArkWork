import { openDatabase, migrate } from "./database";
import { GitHubCli } from "./github";
import { SubscriptionCodex } from "./codex";
import { buildApp } from "./app";

if (process.env.ARKWORK_DEV_AUTH !== "1")
  throw new Error(
    "로컬 개발 API는 ARKWORK_DEV_AUTH=1로 명시적으로 활성화해야 합니다.",
  );
const db = await openDatabase(process.env.DATABASE_URL ?? ".runtime/database");
await migrate(db);
const { app, store, agent } = buildApp(db, {
  devAuth: process.env.ARKWORK_DEV_AUTH === "1",
  origin: process.env.ARKWORK_UI_ORIGIN,
  agent: new SubscriptionCodex(),
  github:
    process.env.ARKWORK_GITHUB_ENABLED === "1"
      ? new GitHubCli(
          (process.env.ARKWORK_GITHUB_REPOSITORIES ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        )
      : undefined,
});
let inFlight: Promise<void> | undefined;
let stopping = false;
try {
  await app.listen({
    host: "127.0.0.1",
    port: Number(process.env.ARKWORK_API_PORT ?? 3001),
  });
} catch (error) {
  await db.close();
  throw error;
}
const timer = setInterval(() => {
  if (inFlight || stopping) return;
  inFlight = Promise.all([store.tick(), agent?.tick()])
    .then(() => undefined)
    .catch(() => {
      console.error(
        "작업 실행 상태를 갱신하지 못했습니다. 다음 주기에 상태를 다시 확인합니다.",
      );
    })
    .finally(() => {
      inFlight = undefined;
    });
}, 300);
console.log(
  "ArkWork 로컬 개발 API 준비 완료 · 구현은 서버 모의 · Codex 질문·명세는 별도 활성화와 구독 로그인 필요",
);
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await inFlight;
  await app.close();
  await db.close();
}
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
