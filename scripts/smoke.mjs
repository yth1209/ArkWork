import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.APP_URL || 'http://localhost:5173');
    await page.getByRole('button', { name: /데모 작업 시작/ }).click();
    await page.getByRole('alert').filter({ hasText: '10~2,000자' }).waitFor();
    await page.getByRole('button', { name: /팀을 위한 업무 관리/ }).click();
    assert.match(await page.getByLabel('어떤 소프트웨어를 만들까요?').inputValue(), /업무 관리/);
    await page.getByRole('button', { name: /데모 작업 시작/ }).click();
    await page.getByRole('button', { name: '데모 작업 취소' }).click();
    await page.getByRole('heading', { name: '작업이 취소되었습니다' }).waitFor();
    await page.getByRole('button', { name: /새 작업 만들기/ }).click();
    await page.getByLabel('어떤 소프트웨어를 만들까요?').fill('고객 문의를 관리하고 답변 상태를 확인하는 대시보드를 만들어 주세요.');
    await page.getByRole('button', { name: /데모 작업 시작/ }).click();
    await page.getByRole('heading', { name: '결과를 검토할 차례입니다' }).waitFor({ timeout: 15000 });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /작업 요약 다운로드/ }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^arkwork-.*\.md$/);
    await page.reload();
    await page.getByRole('button', { name: /작업 기록/ }).click();
    await page.getByRole('heading', { name: '작업 기록', exact: true }).waitFor();
    assert.equal(await page.locator('.history-list > button').count(), 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'No horizontal overflow');
    assert.deepEqual(errors, [], 'No browser runtime errors');
    console.log(`PASS ${viewport.width}px: validation, example, cancel, progress, download, persistence, layout`);
    await context.close();
  }
} finally { await browser.close(); }
