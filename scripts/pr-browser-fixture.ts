// Isolated browser test. Never imports GitHubCli or calls GitHub / Codex.
import { openDatabase, migrate } from "../server/database";
import { HttpError } from "../server/store";
import { buildApp } from "../server/app";
import type { GitHubProvider, Snapshot } from "../server/github";
if (process.env.ARKWORK_PR_TEST_FIXTURE !== "1")
  throw new Error("PR fixture requires explicit test opt-in");
const db = await openDatabase(":memory:");
await migrate(db);
let next = 1;
const calls = new Map<number, number>();
const submissions = new Set<string>();
const snapshot = (number: number, sha = "a".repeat(40)): Snapshot => ({
  number,
  url: `https://github.com/fixture/repo/pull/${number}`,
  headSha: sha,
  open: true,
  draft: false,
  checks: "passed",
  files: [
    {
      path: "src/아주-긴-변경-파일-이름-반응형-화면-검토.ts",
      additions: 12,
      deletions: 2,
    },
  ],
  filesTruncated: false,
});
const provider: GitHubProvider = {
  repositories: ["fixture/repo"],
  async publish(_target, work) {
    if (!submissions.has(work.id)) {
      submissions.add(work.id);
      throw new HttpError(
        502,
        "GITHUB_UNAVAILABLE",
        "테스트 대역: 생성 결과 불명확, 재확인 필요",
      );
    }
    const number = next++;
    calls.set(number, 0);
    return snapshot(number);
  },
  async inspect(_target, number) {
    const count = (calls.get(number) ?? 0) + 1;
    calls.set(number, count);
    return snapshot(
      number,
      (count === 1 ? "a" : count >= 4 ? "c" : "b").repeat(40),
    );
  },
};
const { app, store } = buildApp(db, {
  devAuth: true,
  origin: "http://localhost:5176",
  intervalMs: 0,
  github: provider,
});
await app.listen({ host: "127.0.0.1", port: 3004 });
let busy = false;
const timer = setInterval(() => {
  if (busy) return;
  busy = true;
  void store.tick().finally(() => {
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
