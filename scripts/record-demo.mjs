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
api.stderr.on("data", (chunk) => { apiError += chunk.toString(); });
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
  return new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23).replace(".", ",");
}
async function run(command, args) {
  await new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => { error += chunk.toString(); });
    child.once("error", fail);
    child.once("exit", (code) => code === 0 ? done() : fail(new Error(error)));
  });
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (api.exitCode !== null) throw new Error(apiError || "API exited before startup");
    try {
      const response = await fetch("http://127.0.0.1:3002/health");
      ready = response.ok;
    } catch { /* Wait for the isolated API to listen. */ }
    if (ready) break;
    await pause(200);
  }
  assert.ok(ready, "Recording API did not start");
  vite = await createServer({
    server: {
      host: "127.0.0.1", port: 5174, strictPort: true,
      proxy: { "/v1": "http://127.0.0.1:3002", "/health": "http://127.0.0.1:3002" },
    },
  });
  await vite.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: temporary, size: { width: 1440, height: 900 } },
    locale: "ko-KR", reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  beginning = performance.now();
  caption("ArkWork 실행 데모 · 실제 AI 호출이 없는 서버 모의 실행입니다.");
  await page.goto("http://localhost:5174");
  await page.getByRole("button", { name: "서버 모의 실행", exact: true }).click();
  const save = page.getByRole("button", { name: /요구사항 저장/ });
  await save.waitFor();
  await pause(2500);

  caption("1. 만들고 싶은 소프트웨어의 요구사항을 입력합니다.");
  const prompt = "팀 업무를 관리하는 웹 앱을 만들어 주세요. 할 일 등록, 담당자 지정, 진행 상태 변경과 마감일 필터가 필요합니다.";
  await page.getByLabel("어떤 소프트웨어를 만들까요?").pressSequentially(prompt, { delay: 45 });
  await pause(1800);
  await save.click();
  await page.getByRole("heading", { name: "계획을 확인하고 실행을 승인해 주세요" }).waitFor();
  caption("2. 실행 계획과 한도를 확인합니다. 승인 전에는 실행하지 않습니다.");
  const approve = page.getByRole("button", { name: "계획 승인 후 모의 실행" });
  assert.equal(await approve.isEnabled(), false);
  await pause(3500);
  await approve.scrollIntoViewIfNeeded();
  await pause(2000);
  await page.getByRole("checkbox", { name: "위 범위와 제한을 확인했으며 서버 모의 실행을 승인합니다." }).check();
  await pause(1400);
  await approve.click();
  caption("3. 승인한 작업을 서버 큐에서 실행하고 진행 상태를 갱신합니다.");
  await page.locator(".detail-heading").scrollIntoViewIfNeeded();
  await page.getByRole("heading", { name: "결과를 검토할 차례입니다" }).waitFor({ timeout: 20000 });
  await pause(2200);
  caption("4. 모의 실행 결과와 실제 구현 전에 확인할 항목을 검토합니다.");
  await page.locator(".result").scrollIntoViewIfNeeded();
  await pause(3500);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "작업 요약 다운로드 ↓" }).click();
  const download = await downloadEvent;
  await download.saveAs(join(output, "sample-work-summary.md"));
  caption("작업 요약을 Markdown 파일로 다운로드할 수 있습니다.");
  await pause(2300);
  await page.getByRole("button", { name: /작업 기록/ }).first().click();
  await page.locator(".history-list > button").filter({ hasText: prompt }).waitFor();
  caption("5. 작업 기록은 서버에 저장되어 새로고침 후에도 조회됩니다.");
  await pause(2200);
  await page.reload();
  await page.getByRole("button", { name: /작업 기록/ }).first().click();
  const history = page.locator(".history-list > button").filter({ hasText: prompt });
  await history.waitFor();
  await pause(2000);
  await history.click();
  await page.getByRole("heading", { name: "결과를 검토할 차례입니다" }).waitFor();
  caption("요구사항 → 승인 → 진행 → 결과 검토 · 실제 AI는 후속 단계입니다.");
  await pause(3500);
  captions.at(-1).end = (performance.now() - beginning) / 1000;
  assert.deepEqual(errors, []);
  const video = page.video();
  await context.close(); context = undefined;
  const raw = await video.path();
  const subtitles = join(temporary, "captions.srt");
  await writeFile(subtitles, captions.map((item, index) =>
    `${index + 1}\n${timestamp(item.start)} --> ${timestamp(item.end)}\n${item.text}\n`).join("\n"));
  await run("ffmpeg", ["-y", "-i", raw, "-vf",
    `pad=1440:1000:0:0:color=0x10141e,subtitles=${subtitles}:force_style='FontName=Noto Sans CJK KR,FontSize=14,PrimaryColour=&H00FFFFFF,Outline=0,MarginV=8'`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", join(output, "arkwork-demo.mp4")]);
  await run("ffmpeg", ["-y", "-ss", "3", "-i", join(output, "arkwork-demo.mp4"), "-frames:v", "1", join(output, "poster.jpg")]);
  console.log(`Saved ${join(output, "arkwork-demo.mp4")}`);
} finally {
  await context?.close();
  await browser?.close();
  await vite?.close();
  api.kill("SIGTERM");
  if (api.exitCode === null) {
    await Promise.race([new Promise((done) => api.once("exit", done)), pause(5000)]);
    if (api.exitCode === null) api.kill("SIGKILL");
  }
  await rm(temporary, { recursive: true, force: true });
}
