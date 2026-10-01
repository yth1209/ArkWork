import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const base = process.env.APP_URL || "http://localhost:5173";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page
      .getByRole("button", { name: "서버 모의 실행", exact: true })
      .click();
    const start = page.getByRole("button", { name: /요구사항 저장/ });
    await start.waitFor();
    const prompt = `브라우저 ${width}px에서 서버에 작업을 저장하고 다른 브라우저에서도 진행 상태를 확인해 주세요. ${Date.now()}`;
    await page.getByLabel("어떤 소프트웨어를 만들까요?").fill(prompt);
    await start.click();
    await page
      .getByRole("heading", {
        name: "요구사항에 대한 답변을 기다리고 있습니다",
      })
      .waitFor();
    await page.waitForTimeout(2200);
    const beforeAnswer = await (
      await context.request.get(`${base}/v1/work-items`)
    ).json();
    assert.equal(
      beforeAnswer.runs.find((item) => item.prompt === prompt).state,
      "awaiting_input",
    );
    await page.getByRole("button", { name: "서버 모의 작업 취소" }).click();
    await page
      .getByRole("heading", { name: "작업이 취소되었습니다" })
      .waitFor();
    await page.getByRole("button", { name: /새 작업 만들기/ }).click();
    const second = prompt + " 계속 진행";
    await page.getByLabel("어떤 소프트웨어를 만들까요?").fill(second);
    await start.click();
    const answer =
      "팀원이 작업을 등록하고 상태를 변경하면 완료입니다. 외부 연동과 알림은 제외합니다.";
    await page.getByLabel("요구사항 확인 답변").fill(answer);
    await page.getByRole("button", { name: "답변 저장 · 계획 확인" }).click();
    await page
      .getByRole("heading", { name: "계획을 확인하고 실행을 승인해 주세요" })
      .waitFor();
    const approve = page.getByRole("button", {
      name: "계획 승인 후 모의 실행",
    });
    assert.equal(await approve.isEnabled(), false);
    await page
      .locator(".approval-panel")
      .locator("p")
      .filter({ hasText: answer })
      .waitFor();
    const execute = async () => {
      await page
        .getByRole("checkbox", {
          name: "위 범위와 제한을 확인했으며 서버 모의 실행을 승인합니다.",
        })
        .check();
      await approve.click();
      await page
        .getByRole("heading", { name: "결정이 필요해 진행을 멈췄습니다" })
        .waitFor({ timeout: 15000 });
      const paused = (
        await (await context.request.get(`${base}/v1/work-items`)).json()
      ).runs.find((item) => item.prompt === second);
      await page.waitForTimeout(2200);
      const held = (
        await (await context.request.get(`${base}/v1/work-items`)).json()
      ).runs.find((item) => item.id === paused.id);
      assert.equal(held.version, paused.version);
      await page
        .getByRole("button", { name: "승인한 범위로 계속 진행" })
        .click();
      await page
        .getByRole("heading", { name: "결과를 검토할 차례입니다" })
        .waitFor({ timeout: 15000 });
    };
    await execute();
    const feedback = "완료 조건에 마감일 필터와 빈 목록 안내를 포함해 주세요.";
    await page.getByLabel("수정 의견").fill(feedback);
    await page
      .getByRole("button", { name: "수정 의견 제출 · 계획 다시 검토" })
      .click();
    await page
      .getByRole("heading", { name: "계획을 확인하고 실행을 승인해 주세요" })
      .waitFor();
    assert.equal(await approve.isEnabled(), false);
    await page
      .locator(".approval-panel")
      .locator("p")
      .filter({ hasText: feedback })
      .waitFor();
    await execute();
    await page.getByRole("button", { name: "결과 승인 · 작업 완료" }).click();
    await page
      .getByRole("heading", { name: "검토를 마치고 작업을 완료했습니다" })
      .waitFor();
    await page
      .locator(".human-history")
      .getByText(feedback, { exact: true })
      .waitFor();
    await page.screenshot({
      path: `/tmp/arkwork-human-${width}.png`,
      fullPage: true,
    });
    const streamResponse = await context.request.get(`${base}/v1/work-items`);
    const { runs } = await streamResponse.json();
    const run = runs.find((item) => item.prompt === second);
    assert.equal(run.state, "completed");
    assert.equal(run.revision, 1);
    assert.equal(
      run.humanHistory.filter((item) => item.action === "approve_plan").length,
      2,
    );
    // Check actual SSE wire data and resume cursor, rather than a successful list poll alone.
    const eventData = await page.evaluate(
      async ({ id, version }) => {
        const response = await fetch(
          `/v1/work-items/${id}/events?cursor=${version - 2}`,
        );
        const reader = response.body.getReader();
        let data = "";
        try {
          while (!data.includes(`id: ${version}\n`)) {
            const next = await reader.read();
            if (next.done) break;
            data += new TextDecoder().decode(next.value);
          }
        } finally {
          await reader.cancel();
        }
        return data;
      },
      { id: run.id, version: run.version },
    );
    assert.ok(eventData.includes(`id: ${run.version - 1}\n`));
    assert.ok(eventData.includes(`id: ${run.version}\n`));
    assert.ok(!eventData.includes(`id: ${run.version - 2}\n`));
    const other = await browser.newContext({
      viewport: { width, height: 1000 },
    });
    const otherPage = await other.newPage();
    await otherPage.goto(base);
    await otherPage
      .getByRole("button", { name: "서버 모의 실행", exact: true })
      .click();
    await otherPage.getByRole("button", { name: /작업 기록/ }).click();
    await otherPage
      .locator(".history-list > button")
      .filter({ hasText: second })
      .waitFor();
    await otherPage.reload();
    await otherPage.getByRole("button", { name: /작업 기록/ }).click();
    await otherPage
      .locator(".history-list > button")
      .filter({ hasText: second })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    console.log(
      `PASS API ${width}px: questions, approval, decision hold, feedback, reapproval, acceptance, cancel, SSE cursor, persistence, reload, layout`,
    );
    await other.close();
    await context.close();
  }
} finally {
  await browser.close();
}
