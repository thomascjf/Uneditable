// 补充 Mojo 项目截图：手机投票（自带 gas / 指纹上链）+ 后台篡改页。
// 拍的是线上真实页面；上传后 PATCH 项目 meta.screenshots，保留原有大屏截图。
// 凭证只从 .mojo/agent.json 读取，绝不打印、绝不发往其它域名。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = JSON.parse(fs.readFileSync(path.join(root, '.mojo', 'agent.json'), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const BASE = agent.baseUrl || 'https://mojo.devnads.com';
const H = { Authorization: 'Bearer ' + agent.agentSecret, 'Content-Type': 'application/json' };
const SITE = (cfg.baseUrl || '').replace(/\/$/, '');
const CODE = cfg.shareCode || '';
const pageUrl = (p) => SITE + p + (CODE ? '?sharecode=' + encodeURIComponent(CODE) : '');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FORCE = process.env.FORCE === '1';   // 重拍后替换已上传的三张补充图
const OUT = path.join(root, 'assets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const json = async (url, init = {}) => {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
};

// 截图顶部的说明条：让审核者一眼区分两条路径（明确标注为演示说明）
const banner = (text) => `
  position:relative;z-index:9;margin:0 0 12px;padding:10px 14px;border-radius:10px;
  background:linear-gradient(90deg,#6d4ce0,#9b7bff);color:#fff;font-size:14px;
  font-weight:700;line-height:1.5;text-align:center;box-shadow:0 4px 18px rgba(0,0,0,.35)`;
const addBanner = async (page, text) => page.evaluate((css, t) => {
  const d = document.createElement('div');
  d.style.cssText = css;
  d.textContent = '演示说明 · ' + t;
  document.body.prepend(d);
}, banner, text);

async function shotVote(browser, filename, selfGas, label) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 1000, deviceScaleFactor: 2 });
  await page.goto(pageUrl('/vote.html'), { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForSelector('.team', { timeout: 30000 });
  await page.evaluate((self) => {
    const cb = document.getElementById('selfGas');
    cb.checked = self;
    if (typeof syncMode === 'function') syncMode();
    const t = document.querySelector('.team[data-id="685"]') || document.querySelector('.team');
    if (t) t.click();
    const ta = document.getElementById('text');
    if (ta) ta.value = '第一次用指纹投票，居然真的上链了';
  }, selfGas);
  await addBanner(page, label);
  await sleep(900);
  const file = path.join(OUT, filename);
  await page.screenshot({ path: file });
  const state = await page.evaluate(() => ({
    selfGas: document.getElementById('selfGas').checked,
    button: document.getElementById('submit').textContent.trim(),
    enableVisible: document.getElementById('enable').style.display !== 'none'
  }));
  console.log('  ' + filename, JSON.stringify(state), fs.statSync(file).size + ' bytes');
  await page.close();
}

async function shotAdmin(browser, filename, label) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 960, deviceScaleFactor: 1 });
  await page.goto(pageUrl('/admin.html'), { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForSelector('#state .state-row', { timeout: 30000 });
  // 触发一次真实篡改，让「最近改动」与日志入镜；截完立刻重置演示数据
  await page.evaluate(() => {
    document.getElementById('voteVal').value = '999';
    document.querySelector('[data-op="setVotes"]').click();
  });
  await page.waitForFunction(() => document.getElementById('log').textContent.includes('✓'), { timeout: 15000 });
  await addBanner(page, label);
  await sleep(900);
  const file = path.join(OUT, filename);
  await page.screenshot({ path: file });
  console.log('  ' + filename, fs.statSync(file).size + ' bytes', '| log:', await page.$eval('#log', (e) => e.textContent.trim()));
  await page.close();
  // 恢复线上中心化库，避免留下 999 票
  const r = await fetch(pageUrl('/api/central/seed'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamIds: [685, 684, 683, 681, 680, 679] })
  });
  console.log('  reseed online central store:', r.status);
}

async function uploadShot(filename) {
  const buf = fs.readFileSync(path.join(OUT, filename));
  const a = await json(BASE + '/api/agent/uploads', {
    method: 'POST', headers: H,
    body: JSON.stringify({ filename, contentType: 'image/png', size: buf.length })
  });
  if (a.status >= 300) throw new Error('uploads request failed: ' + JSON.stringify(a.body));
  const { uuid, uploadUrl, path: p } = a.body.data;
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: buf });
  if (!put.ok) throw new Error('S3 PUT failed: ' + put.status);
  const c = await json(BASE + '/api/agent/uploads/confirm', {
    method: 'POST', headers: H, body: JSON.stringify({ uuid })
  });
  if (c.status >= 300) throw new Error('confirm failed: ' + JSON.stringify(c.body));
  console.log('  uploaded', filename, '(' + buf.length + ' bytes)');
  return { uuid, path: p };
}

const FILES = [
  'vote-selfgas.png',
  'vote-passkey.png',
  'admin-tamper.png'
];

const main = async () => {
  console.log('[1/3] 拍摄线上页面截图');
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars']
  });
  try {
    await shotVote(browser, FILES[0], true, '① 自带 gas：连钱包 EIP-712 直签');
    await shotVote(browser, FILES[1], false, '② 指纹上链：passkey + 转发器代付 gas + 合约验签');
    await shotAdmin(browser, FILES[2], '③ 后台篡改：只改中心化库，右栏链上数据纹丝不动');
  } finally {
    await browser.close();
  }

  console.log('[2/3] 读取 Mojo 项目当前截图');
  const cur = await json(BASE + '/api/agent/projects?eventId=18', { headers: H });
  const proj = cur.body?.data?.project;
  if (!proj) throw new Error('Mojo 项目不存在（eventId=18）');
  let meta = typeof proj.meta === 'string' ? JSON.parse(proj.meta) : (proj.meta || {});
  const oldShots = Array.isArray(meta.screenshots) ? meta.screenshots : [];
  console.log('  project', proj.id, proj.name, proj.status, '| existing shots', oldShots.length);

  let shots = oldShots;
  if (meta.extraShotsAdded && !FORCE) {
    console.log('  补充截图已存在，跳过重复上传（FORCE=1 可强制重传）');
  } else {
    const added = [];
    for (const f of FILES) added.push(await uploadShot(f));
    // 重传时替换末尾三张，保留原有大屏「篡改前 / 篡改后」截图
    const base = FORCE && oldShots.length >= FILES.length
      ? oldShots.slice(0, oldShots.length - FILES.length)
      : oldShots;
    shots = [...base, ...added];
    meta = { ...meta, screenshots: shots, extraShotsAdded: true };
    const body = {
      name: proj.name,
      description: proj.description,
      url: proj.url,
      eventId: 18,
      meta
    };
    const res = await json(BASE + '/api/agent/projects/' + proj.id, {
      method: 'PATCH', headers: H, body: JSON.stringify(body)
    });
    console.log('  PATCH http', res.status);
    if (res.status >= 300) throw new Error('project update failed: ' + JSON.stringify(res.body).slice(0, 400));
  }

  console.log('[3/3] 复核');
  const check = await json(BASE + '/api/agent/projects?eventId=18', { headers: H });
  const p2 = check.body?.data?.project;
  const m2 = typeof p2?.meta === 'string' ? JSON.parse(p2.meta) : (p2?.meta || {});
  console.log(JSON.stringify({
    id: p2?.id, name: p2?.name, status: p2?.status,
    screenshots: (m2.screenshots || []).length,
    github: m2.github, url: p2?.url
  }));
  console.log('MOJO EXTRA SHOTS DONE');
};

main().catch((e) => { console.error('MOJO EXTRA SHOTS ERROR:', e.message); process.exit(1); });
