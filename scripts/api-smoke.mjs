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
    const start = page.getByRole("button", { name: /서버 모의 작업 시작/ });
    await start.waitFor();
    const prompt = `브라우저 ${width}px에서 서버에 작업을 저장하고 다른 브라우저에서도 진행 상태를 확인해 주세요. ${Date.now()}`;
    await page.getByLabel("어떤 소프트웨어를 만들까요?").fill(prompt);
    await start.click();
    await page
      .getByRole("heading", { name: "아이디어를 구체화하고 있습니다" })
      .waitFor();
    await page.getByRole("button", { name: "서버 모의 작업 취소" }).click();
    await page
      .getByRole("heading", { name: "작업이 취소되었습니다" })
      .waitFor();
    await page.getByRole("button", { name: /새 작업 만들기/ }).click();
    const second = prompt + " 계속 진행";
    await page.getByLabel("어떤 소프트웨어를 만들까요?").fill(second);
    await start.click();
    await page
      .getByRole("heading", { name: "결과를 검토할 차례입니다" })
      .waitFor({ timeout: 15000 });
    const streamResponse = await context.request.get(`${base}/v1/work-items`);
    const { runs } = await streamResponse.json();
    const run = runs.find((item) => item.prompt === second);
    assert.equal(run.state, "review_ready");
    // Check actual SSE wire data and resume cursor, rather than a successful list poll alone.
    const eventData = await page.evaluate(async (id) => {
      const response = await fetch(`/v1/work-items/${id}/events?cursor=3`);
      const reader = response.body.getReader();
      let data = "";
      try {
        while (!data.includes("id: 5")) {
          const next = await reader.read();
          if (next.done) break;
          data += new TextDecoder().decode(next.value);
        }
      } finally {
        await reader.cancel();
      }
      return data;
    }, run.id);
    assert.match(eventData, /id: 4/);
    assert.match(eventData, /id: 5/);
    assert.doesNotMatch(eventData, /id: 3/);
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
      `PASS API ${width}px: create, cancel, server progress, SSE cursor, independent browser persistence, reload, layout`,
    );
    await other.close();
    await context.close();
  }
} finally {
  await browser.close();
}
