import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
const api = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/codex-browser-fixture.ts"],
  {
    env: { ...process.env, ARKWORK_CODEX_TEST_FIXTURE: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
let error = "";
api.stderr.on("data", (chunk) => {
  error += chunk;
});
let vite, browser;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (api.exitCode !== null) throw new Error(error || "Fixture API failed");
    try {
      ready = (await fetch("http://127.0.0.1:3003/health")).ok;
    } catch {}
    if (ready) break;
    await pause(200);
  }
  assert.ok(ready, "Fixture API startup timed out");
  vite = await createServer({
    server: {
      host: "127.0.0.1",
      port: 5175,
      strictPort: true,
      proxy: {
        "/v1": "http://127.0.0.1:3003",
        "/health": "http://127.0.0.1:3003",
      },
    },
  });
  await vite.listen();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
        viewport: { width, height: 1000 },
      }),
      page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:5175");
    await page
      .getByLabel("어떤 소프트웨어를 만들까요?")
      .fill("작업을 등록하고 담당자를 지정하는 업무 관리 앱을 만들어 주세요.");
    await page.getByRole("button", { name: /요구사항 저장/ }).click();
    const generate = page.getByRole("button", {
      name: "구독 사용 · Codex 질문 작성",
    });
    await generate.waitFor();
    await generate.click();
    await page
      .locator(".human-checkpoint")
      .getByText("Codex 테스트 질문: 이 앱의 사용자는 누구인가요?", {
        exact: true,
      })
      .waitFor();
    await page
      .getByLabel("요구사항 확인 답변")
      .fill(
        "팀 구성원이 사용하고 등록과 상태 변경을 확인하면 완료입니다. 외부 연동은 제외합니다.",
      );
    await page.getByRole("button", { name: "답변 저장 · 계획 확인" }).click();
    await page
      .getByRole("button", { name: "구독 사용 · Codex 명세 작성" })
      .click();
    await page
      .locator(".codex-specification")
      .getByText("Codex 테스트 명세: 팀 업무 관리", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "계획 승인 후 모의 실행" })
        .isEnabled(),
      false,
    );
    await page.reload();
    await page
      .getByRole("button", { name: /작업 기록/ })
      .first()
      .click();
    await page.locator(".history-list > button").first().click();
    await page
      .locator(".codex-specification")
      .getByText("Codex 테스트 명세: 팀 업무 관리", { exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: `/tmp/arkwork-codex-fixture-${width}.png`,
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      `PASS Codex fixture ${width}px: questions, human answer, specification, approval hold, reload, layout; no real AI call`,
    );
    await context.close();
  }
} finally {
  await browser?.close();
  await vite?.close();
  api.kill("SIGTERM");
  if (api.exitCode === null) {
    await Promise.race([
      new Promise((done) => api.once("exit", done)),
      pause(5000),
    ]);
    if (api.exitCode === null) api.kill("SIGKILL");
  }
}
