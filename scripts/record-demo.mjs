import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

// Isolated database and ports keep the recording separate from development data.
const output = resolve(process.env.DEMO_OUTPUT || "docs/demo");
const temporary = await mkdtemp(join(tmpdir(), "arkwork-demo-"));
await mkdir(output, { recursive: true });
const api = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
  env: {
    ...process.env,
    ARKWORK_DEV_AUTH: "1",
    ARKWORK_API_PORT: "3002",
    ARKWORK_UI_ORIGIN: "http://localhost:5174",
    DATABASE_URL: join(temporary, "database"),
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let apiError = "";
api.stderr.on("data", (chunk) => {
  apiError += chunk.toString();
});
let vite, browser, context;
const captions = [];
let beginning;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
function caption(text) {
  const seconds = (performance.now() - beginning) / 1000;
  if (captions.length) captions.at(-1).end = seconds;
  captions.push({ start: seconds, text });
  console.log(text);
}
function timestamp(seconds) {
  return new Date(Math.round(seconds * 1000))
    .toISOString()
    .slice(11, 23)
    .replace(".", ",");
}
async function run(command, args) {
  await new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => {
      error += chunk.toString();
    });
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0 ? done() : fail(new Error(error)),
    );
  });
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (api.exitCode !== null)
      throw new Error(apiError || "API exited before startup");
    try {
      const response = await fetch("http://127.0.0.1:3002/health");
      ready = response.ok;
    } catch {
      /* Wait for the isolated API to listen. */
    }
    if (ready) break;
    await pause(200);
  }
  assert.ok(ready, "Recording API did not start");
  vite = await createServer({
    server: {
      host: "127.0.0.1",
      port: 5174,
      strictPort: true,
      proxy: {
        "/v1": "http://127.0.0.1:3002",
        "/health": "http://127.0.0.1:3002",
      },
    },
  });
  await vite.listen();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: temporary, size: { width: 1440, height: 900 } },
    locale: "ko-KR",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  beginning = performance.now();
  caption("ArkWork 실행 데모 · 실제 AI 호출이 없는 서버 모의 실행입니다.");
  await page.goto("http://localhost:5174");
  await page
    .getByRole("button", { name: "서버 모의 실행", exact: true })
    .click();
  const save = page.getByRole("button", { name: /요구사항 저장/ });
  await save.waitFor();
  await pause(2500);

  caption("1. 만들고 싶은 소프트웨어의 요구사항을 입력합니다.");
  const prompt =
    "팀 업무를 관리하는 웹 앱을 만들어 주세요. 할 일 등록, 담당자 지정, 진행 상태 변경과 마감일 필터가 필요합니다.";
  await page
    .getByLabel("어떤 소프트웨어를 만들까요?")
    .pressSequentially(prompt, { delay: 45 });
  await pause(1800);
  await save.click();
  await page
    .getByRole("heading", { name: "요구사항에 대한 답변을 기다리고 있습니다" })
    .waitFor();
  caption("2. 사용자와 완료 조건을 질문합니다. 답변 전에는 진행하지 않습니다.");
  await page.locator(".human-checkpoint").scrollIntoViewIfNeeded();
  await pause(2500);
  await page
    .getByLabel("요구사항 확인 답변")
    .pressSequentially(
      "작은 팀의 업무 담당자가 사용합니다. 업무 등록과 상태 변경, 마감일 필터가 동작하면 완료입니다. 알림과 외부 연동은 제외합니다.",
      { delay: 25 },
    );
  await pause(1000);
  await page.getByRole("button", { name: "답변 저장 · 계획 확인" }).click();
  await page
    .getByRole("heading", { name: "계획을 확인하고 실행을 승인해 주세요" })
    .waitFor();
  caption("3. 실행 계획과 한도를 확인합니다. 승인 전에는 실행하지 않습니다.");
  const approve = page.getByRole("button", { name: "계획 승인 후 모의 실행" });
  assert.equal(await approve.isEnabled(), false);
  await pause(3500);
  await approve.scrollIntoViewIfNeeded();
  await pause(2000);
  await page
    .getByRole("checkbox", {
      name: "위 범위와 제한을 확인했으며 서버 모의 실행을 승인합니다.",
    })
    .check();
  await pause(1400);
  await approve.click();
  caption("승인한 계획을 서버 큐에서 모의 실행합니다.");
  await page.locator(".detail-heading").scrollIntoViewIfNeeded();
  await page
    .getByRole("heading", { name: "결정이 필요해 진행을 멈췄습니다" })
    .waitFor({ timeout: 20000 });
  caption(
    "4. 구현 전 결정 지점에서 멈춥니다. 사용자가 계속 진행을 선택합니다.",
  );
  await page.locator(".human-checkpoint").scrollIntoViewIfNeeded();
  await pause(3000);
  await page.getByRole("button", { name: "승인한 범위로 계속 진행" }).click();
  await page
    .getByRole("heading", { name: "결과를 검토할 차례입니다" })
    .waitFor({ timeout: 20000 });
  await pause(2200);
  caption("5. 모의 결과를 검토하고 수정 의견으로 다시 계획을 검토합니다.");
  await page.locator(".result").scrollIntoViewIfNeeded();
  await pause(3500);
  await page
    .getByLabel("수정 의견")
    .pressSequentially(
      "마감일 필터에 빈 결과 안내를 추가하고 이를 완료 조건에 포함해 주세요.",
      { delay: 35 },
    );
  await pause(1800);
  await page
    .getByRole("button", { name: "수정 의견 제출 · 계획 다시 검토" })
    .click();
  await page
    .getByRole("heading", { name: "계획을 확인하고 실행을 승인해 주세요" })
    .waitFor();
  caption(
    "수정 의견이 계획에 저장됩니다. 이전 승인은 새 계획에 적용되지 않습니다.",
  );
  await page.locator(".approval-panel .plan-inputs").scrollIntoViewIfNeeded();
  await pause(3200);
  assert.equal(await approve.isEnabled(), false);
  await page
    .getByRole("checkbox", {
      name: "위 범위와 제한을 확인했으며 서버 모의 실행을 승인합니다.",
    })
    .check();
  await pause(1200);
  await approve.click();
  await page
    .getByRole("heading", { name: "결정이 필요해 진행을 멈췄습니다" })
    .waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "승인한 범위로 계속 진행" }).click();
  await page
    .getByRole("heading", { name: "결과를 검토할 차례입니다" })
    .waitFor({ timeout: 20000 });
  caption("6. 재검토한 결과를 사용자가 승인해야 작업이 완료됩니다.");
  await page.locator(".result").scrollIntoViewIfNeeded();
  await pause(3000);
  await page.getByRole("button", { name: "결과 승인 · 작업 완료" }).click();
  await page
    .getByRole("heading", { name: "검토를 마치고 작업을 완료했습니다" })
    .waitFor();
  await page.locator(".human-history").scrollIntoViewIfNeeded();
  caption("답변 · 승인 · 결정 · 수정 의견의 이력을 서버에 보존합니다.");
  await pause(3000);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "작업 요약 다운로드 ↓" }).click();
  const download = await downloadEvent;
  await download.saveAs(join(output, "sample-work-summary.md"));
  await pause(1300);
  await page
    .getByRole("button", { name: /작업 기록/ })
    .first()
    .click();
  await page
    .locator(".history-list > button")
    .filter({ hasText: prompt })
    .waitFor();
  caption("7. 새로고침 후에도 완료 상태와 결정 기록을 조회할 수 있습니다.");
  await pause(2200);
  await page.reload();
  await page
    .getByRole("button", { name: /작업 기록/ })
    .first()
    .click();
  const history = page
    .locator(".history-list > button")
    .filter({ hasText: prompt });
  await history.waitFor();
  await pause(2000);
  await history.click();
  await page
    .getByRole("heading", { name: "검토를 마치고 작업을 완료했습니다" })
    .waitFor();
  caption("요구사항 → 승인 → 진행 → 결과 검토 · 실제 AI는 후속 단계입니다.");
  await pause(3500);
  captions.at(-1).end = (performance.now() - beginning) / 1000;
  assert.deepEqual(errors, []);
  const video = page.video();
  await context.close();
  context = undefined;
  const raw = await video.path();
  const subtitles = join(temporary, "captions.srt");
  await writeFile(
    subtitles,
    captions
      .map(
        (item, index) =>
          `${index + 1}\n${timestamp(item.start)} --> ${timestamp(item.end)}\n${item.text}\n`,
      )
      .join("\n"),
  );
  await run("ffmpeg", [
    "-y",
    "-i",
    raw,
    "-vf",
    `pad=1440:1000:0:0:color=0x10141e,subtitles=${subtitles}:force_style='FontName=Noto Sans CJK KR,FontSize=14,PrimaryColour=&H00FFFFFF,Outline=0,MarginV=8'`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    join(output, "arkwork-demo.mp4"),
  ]);
  await run("ffmpeg", [
    "-y",
    "-ss",
    "3",
    "-i",
    join(output, "arkwork-demo.mp4"),
    "-frames:v",
    "1",
    join(output, "poster.jpg"),
  ]);
  console.log(`Saved ${join(output, "arkwork-demo.mp4")}`);
} finally {
  await context?.close();
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
  await rm(temporary, { recursive: true, force: true });
}
