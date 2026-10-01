// Browser test only. This process never imports or invokes SubscriptionCodex.
import { openDatabase, migrate } from "../server/database";
import { buildApp } from "../server/app";
import type { AgentProvider } from "../server/codex";
if (process.env.ARKWORK_CODEX_TEST_FIXTURE !== "1")
  throw new Error("Browser fixture requires explicit test opt-in");
const db = await openDatabase(":memory:");
await migrate(db);
const provider: AgentProvider = {
  status: async () => ({
    enabled: true,
    authenticated: true,
    authMode: "chatgpt-subscription",
    message: "테스트 대역 · 실제 Codex 호출 없음",
  }),
  run: async (phase) => ({
    output:
      phase === "questions"
        ? ["Codex 테스트 질문: 이 앱의 사용자는 누구인가요?"]
        : {
            summary: "Codex 테스트 명세: 팀 업무 관리",
            acceptanceCriteria: ["업무 담당자가 상태를 변경할 수 있다."],
            excludedScope: ["외부 연동"],
          },
    threadId: "browser-fixture-thread",
    usage: { input_tokens: 10, output_tokens: 10 },
  }),
};
const { app, agent } = buildApp(db, {
  devAuth: true,
  origin: "http://localhost:5175",
  agent: provider,
});
await app.listen({ host: "127.0.0.1", port: 3003 });
let busy = false;
const timer = setInterval(() => {
  if (busy) return;
  busy = true;
  void agent!.tick().finally(() => {
    busy = false;
  });
}, 50);
async function close() {
  clearInterval(timer);
  await app.close();
  await db.close();
}
process.once("SIGTERM", () => {
  void close();
});
process.once("SIGINT", () => {
  void close();
});
