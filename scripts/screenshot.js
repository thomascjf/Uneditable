// 现场截图 / Mojo 提交用图：在同一浏览器会话里拍「篡改前」与「篡改后」，
// 让 SSE 推来的篡改横幅和「左栏变、右栏不变」同时入镜。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'assets');
fs.mkdirSync(outDir, { recursive: true });
const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const post = async (p, b) => {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b)
  });
  if (!r.ok) throw new Error(p + ' -> ' + r.status);
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars']
});

try {
  // 预置数据，保证左右两栏都有内容
  await post('/api/central/seed', { teamIds: [685, 684, 683, 681, 680, 679] });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(BASE + '/screen.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#centralFeed .entry').length > 0 &&
          document.querySelectorAll('#chainFeed .entry').length > 0,
    { timeout: 25000 }
  );
  await sleep(1200);
  await page.screenshot({ path: path.join(outDir, 'screen-before.png') });
  console.log('assets/screen-before.png : 大屏双栏（篡改前）');

  // 在同一个会话里触发篡改，SSE 会推送横幅 + 左栏变化
  await page.evaluate(async () => {
    await fetch('/api/central/tamper', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'setVotes', payload: { teamId: 685, value: 999 } })
    });
  });
  await page.waitForFunction(
    () => document.getElementById('tamperBanner').classList.contains('show'),
    { timeout: 12000 }
  );
  await sleep(900);
  await page.screenshot({ path: path.join(outDir, 'screen-after.png') });
  console.log('assets/screen-after.png : 篡改后（左栏 999 / 右栏不变 + 横幅）');

  // 手机投票页（备用物料）
  const mobile = await browser.newPage();
  await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await mobile.goto(BASE + '/vote.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await mobile.waitForSelector('.team', { timeout: 20000 });
  await sleep(600);
  await mobile.screenshot({ path: path.join(outDir, 'vote-page.png') });
  console.log('assets/vote-page.png : 手机投票页');
} finally {
  await browser.close();
}
