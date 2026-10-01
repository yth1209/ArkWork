import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
const api = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/pr-browser-fixture.ts"],
  {
    env: { ...process.env, ARKWORK_PR_TEST_FIXTURE: "1" },
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
      ready = (await fetch("http://127.0.0.1:3004/health")).ok;
    } catch {}
    if (ready) break;
    await pause(200);
  }
  assert.ok(ready, "Fixture API startup timed out");
  vite = await createServer({
    server: {
      host: "127.0.0.1",
      port: 5176,
      strictPort: true,
      proxy: {
        "/v1": "http://127.0.0.1:3004",
        "/health": "http://127.0.0.1:3004",
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
    await page.goto("http://localhost:5176");
    await page
      .getByLabel("어떤 소프트웨어를 만들까요?")
      .fill("작업을 등록하고 담당자를 지정하는 업무 관리 앱을 만들어 주세요.");
    await page.getByRole("button", { name: /요구사항 저장/ }).click();
    await page
      .getByLabel("요구사항 확인 답변")
      .fill("팀원이 업무 상태를 변경하면 완료입니다. 외부 연동은 제외합니다.");
    await page.getByRole("button", { name: "답변 저장 · 계획 확인" }).click();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "계획 승인 후 모의 실행" }).click();
    await page.getByRole("button", { name: "승인한 범위로 계속 진행" }).click();
    const panel = page.getByRole("region", { name: "PR 제출과 사람 평가" });
    await panel.waitFor();
    await panel.getByLabel("구현 브랜치").fill("factory/result");
    await panel.getByRole("button", { name: "실제 브랜치로 PR 생성" }).click();
    await panel.getByRole("alert").waitFor();
    await panel.getByRole("button", { name: "PR 생성 결과 재확인" }).click();
    await panel.getByRole("link", { name: /GitHub PR #/ }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "결과 승인 · 작업 완료", exact: true })
        .count(),
      0,
    );
    await panel
      .getByLabel("평가 사유 / 수정 요청")
      .fill("완료 조건에 맞게 상태 필터를 추가해 주세요.");
    await panel.getByRole("button", { name: "수정 요청 · 검토 유지" }).click();
    await panel
      .getByText("완료 조건에 맞게 상태 필터를 추가해 주세요.", {
        exact: false,
      })
      .first()
      .waitFor();
    await panel.getByRole("button", { name: "PR·CI 상태 새로 확인" }).click();
    await panel
      .locator(".pr-sha")
      .first()
      .filter({ hasText: "b".repeat(40) })
      .waitFor();
    await panel
      .getByLabel("평가 사유 / 수정 요청")
      .fill("수정된 커밋과 CI 결과가 완료 조건을 충족합니다.");
    await panel
      .getByRole("button", { name: "이 커밋 승인 · 작업 완료" })
      .click();
    await page
      .getByRole("heading", { name: "검토를 마치고 작업을 완료했습니다" })
      .waitFor();
    await panel.getByRole("button", { name: "PR·CI 상태 새로 확인" }).click();
    await page
      .getByRole("heading", { name: "결과를 검토할 차례입니다" })
      .waitFor();
    await panel
      .locator(".pr-sha")
      .first()
      .filter({ hasText: "c".repeat(40) })
      .waitFor();
    await page.reload();
    await page
      .getByRole("button", { name: /작업 기록/ })
      .first()
      .click();
    await page.locator(".history-list > button").first().click();
    await panel.getByRole("link", { name: /GitHub PR #/ }).waitFor();
    await panel.getByText("커밋별 평가 기록 (2)").waitFor();
    await panel.getByText("커밋별 평가 기록 (2)").click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: `/tmp/arkwork-pr-fixture-${width}.png`,
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      `PASS PR fixture ${width}px: publish retry, changes request, new SHA, approval, approval invalidation, reload, history, layout; no GitHub write`,
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
