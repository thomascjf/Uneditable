// Mojo 参赛提交：查状态 -> 上传自制截图 -> 创建/更新项目 -> pending 待审核。
// 凭证只从 .mojo/agent.json 读取，绝不打印、绝不发往其它域名。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = JSON.parse(fs.readFileSync(path.join(root, '.mojo', 'agent.json'), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const BASE = agent.baseUrl || 'https://mojo.devnads.com';
const H = { Authorization: 'Bearer ' + agent.agentSecret, 'Content-Type': 'application/json' };

const NAME = '指纹上链';
const DESCRIPTION = '这是一个面向非 Web3 背景研发新人和大学生的零门槛上链入口。观众扫码、按一下指纹，10 秒就能在 Monad 测试网投出一票、留下留言，不需要装钱包、助记词或代币。换一份队伍名单，这套入口就能复用于下一场活动。大屏左栏来自中心化数据库、右栏来自 Monad 合约；现场请观众亲手改左栏的票数和留言，右栏纹丝不动，点开交易哈希即可验证——让不了解去中心化的人十秒内看懂：规则写在合约里，谁都改不了。';

const demoUrl = cfg.demoUrl || cfg.baseUrl;
const githubUrl = cfg.githubUrl || 'https://github.com/thomascjf/Uneditable';
if (!demoUrl || demoUrl.includes('localhost')) {
  throw new Error('config.json 缺少公网 demoUrl，不能提交本地链接');
}

const json = async (url, init = {}) => {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
};

async function uploadShot(filename) {
  const file = path.join(root, 'assets', filename);
  const buf = fs.readFileSync(file);
  const contentType = 'image/png';
  const a = await json(BASE + '/api/agent/uploads', {
    method: 'POST', headers: H,
    body: JSON.stringify({ filename, contentType, size: buf.length })
  });
  if (a.status < 200 || a.status >= 300) throw new Error('uploads request failed: ' + JSON.stringify(a.body));
  const { uuid, uploadUrl, path: p } = a.body.data;
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: buf });
  if (!put.ok) throw new Error('S3 PUT failed: ' + put.status + ' ' + (await put.text()).slice(0, 160));
  const c = await json(BASE + '/api/agent/uploads/confirm', {
    method: 'POST', headers: H, body: JSON.stringify({ uuid })
  });
  if (c.status < 200 || c.status >= 300) throw new Error('confirm failed: ' + JSON.stringify(c.body));
  console.log('  uploaded', filename, '(' + buf.length + ' bytes)');
  return { uuid, path: p };
}

const main = async () => {
  const me = await json(BASE + '/api/agent/me', { headers: H });
  console.log('agent:', me.body?.data?.agent?.name || '-', '| status:', me.body?.data?.agent?.status);
  if (me.body?.data?.agent?.status !== 'claimed') throw new Error('Mojo agent 未被认领');

  const cur = await json(BASE + '/api/agent/projects?eventId=18', { headers: H });
  const event = cur.body?.data?.event;
  console.log('event status:', event?.status, '| allowSubmitDuringRegistration:', event?.registration?.allowSubmitDuringRegistration);
  const existing = cur.body?.data?.project || null;
  console.log('existing project:', existing ? existing.id + ' / ' + existing.name : 'null');

  const shots = [];
  for (const f of ['screen-before.png', 'screen-after.png']) shots.push(await uploadShot(f));

  const body = {
    name: NAME,
    description: DESCRIPTION,
    url: demoUrl,
    eventId: 18,
    meta: { github: githubUrl, screenshots: shots }
  };
  const res = existing
    ? await json(BASE + '/api/agent/projects/' + existing.id, { method: 'PATCH', headers: H, body: JSON.stringify(body) })
    : await json(BASE + '/api/agent/projects', { method: 'POST', headers: H, body: JSON.stringify(body) });

  console.log('submit http:', res.status);
  if (res.status >= 300) {
    console.error('submit error:', JSON.stringify(res.body).slice(0, 600));
    process.exit(1);
  }
  console.log('project:', JSON.stringify({
    id: res.body?.data?.project?.id,
    name: res.body?.data?.project?.name,
    status: res.body?.data?.project?.status
  }));
  console.log('demoUrl:', demoUrl);
  console.log('github :', githubUrl);
  console.log('screenshots:', shots.length);
  console.log('Mojo 提交完成，状态 pending，等待主办方人工审核。');
};

main().catch((e) => { console.error('MOJO SUBMIT ERROR:', e.message); process.exit(1); });
