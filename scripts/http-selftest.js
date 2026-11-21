// HTTP 全链路自测：真实走 /api/passkey/register -> /api/challenge ->
// /api/vote/passkey（含服务端 DER 解析 + Web Crypto 预检 + 转发器代付 +
// 合约 0x0100 验签），再验证「中心化可篡改 / 链上不可篡改」的对照。
import { createHash, randomBytes, webcrypto } from 'node:crypto';
const subtle = webcrypto.subtle;
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000';
const HOST = process.env.TEST_RP_ID || 'uneditable.app.workbuddy.host';
const HEADERS = {
  'Content-Type': 'application/json',
  'X-Forwarded-Host': HOST,
  'X-Forwarded-Proto': 'https'
};
// 线上发布平台的分享链接需要 sharecode；无 cookie 的每个请求都要自带
const CODE = process.env.TEST_SHARECODE || '';
const url = (p) => BASE + (CODE
  ? p + (p.includes('?') ? '&' : '?') + 'sharecode=' + encodeURIComponent(CODE)
  : p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
};

const get = async (p) => {
  const r = await fetch(url(p), { headers: HEADERS });
  if (!r.ok) throw new Error('GET ' + p + ' -> ' + r.status);
  return r.json();
};
const post = async (p, b) => {
  const r = await fetch(url(p), { method: 'POST', headers: HEADERS, body: JSON.stringify(b) });
  const j = await r.json();
  if (!r.ok) throw new Error('POST ' + p + ' -> ' + (j.error || r.status));
  return j;
};

// P1363 (r||s) -> ASN.1 DER，浏览器 WebAuthn 返回的就是 DER
function rsToDer(sig) {
  const encInt = (b) => {
    let x = Buffer.from(b);
    while (x.length > 1 && x[0] === 0) x = x.subarray(1);
    if (x[0] & 0x80) x = Buffer.concat([Buffer.from([0]), x]);
    return Buffer.concat([Buffer.from([0x02, x.length]), x]);
  };
  const body = Buffer.concat([encInt(sig.subarray(0, 32)), encInt(sig.subarray(32, 64))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(url('/api/health'))).ok) return; } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error('server not reachable at ' + BASE);
}

const main = async () => {
  await waitServer();
  console.log('target:', BASE, '| simulated host:', HOST);

  // 1) 三个页面 + 配置 + 二维码
  for (const p of ['/screen.html', '/vote.html', '/admin.html', '/style.css']) {
    const r = await fetch(url(p));
    check(p + ' 可访问', r.status === 200);
  }
  const cfg = await get('/api/config');
  check('40 支队伍来自 teams.json', cfg.teams.length === 40, 'count=' + cfg.teams.length);
  check('合约地址已写入配置', /^0x[0-9a-fA-F]{40}$/i.test(cfg.contractAddress), cfg.contractAddress);
  check('二维码按线上 host 生成（非 localhost、带分享码）',
    cfg.urls.vote.startsWith('https://' + HOST + '/vote.html') && !cfg.urls.vote.includes('localhost'),
    cfg.urls.vote);
  const qr = await fetch(url('/api/qr.svg?u=/vote.html'));
  check('二维码 SVG 可生成', qr.ok && (qr.headers.get('content-type') || '').includes('svg'));

  const status = await get('/api/status');
  check('链上状态正常', status.ok === true && status.chainId === 10143,
    JSON.stringify({ chainId: status.chainId, balance: status.balanceMon, locked: status.configLocked }));

  // 2) 预置中心化数据
  await post('/api/central/seed', { teamIds: cfg.teams.slice(0, 6).map((t) => t.id) });
  const seeded = await get('/api/state');
  check('中心化库预置成功', seeded.central.entries.length >= 6,
    'entries=' + seeded.central.entries.length);

  // 3) 构造一枚真实 P-256 passkey 并走完整 HTTP 链路
  const { publicKey, privateKey } = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
  );
  const rawPub = new Uint8Array(await subtle.exportKey('raw', publicKey));
  const hex = (u8) => '0x' + Buffer.from(u8).toString('hex');
  const credIdB64 = Buffer.from(randomBytes(23)).toString('base64url');
  await post('/api/passkey/register', {
    credIdB64, qx: hex(rawPub.slice(1, 33)), qy: hex(rawPub.slice(33, 65))
  });
  check('passkey 注册成功', true);

  const teamId = cfg.teams[1].id;
  const text = '[http-selftest] 全链路指纹投票 ' + new Date().toISOString();
  const ch = await post('/api/challenge', { teamId, text, credIdB64 });
  check('challenge 下发含 rpId/origin', ch.rpId === HOST && ch.origin === 'https://' + HOST);

  const cdj = Buffer.from(JSON.stringify({
    type: 'webauthn.get', challenge: ch.challengeB64,
    origin: ch.origin, crossOrigin: false
  }), 'utf8');
  const authData = Buffer.concat([
    createHash('sha256').update(ch.rpId, 'utf8').digest(),
    Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])
  ]);
  const signed = Buffer.concat([authData, createHash('sha256').update(cdj).digest()]);
  const sig = Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, signed));
  const assertion = {
    credIdB64,
    authDataB64: authData.toString('base64url'),
    clientDataJSONB64: cdj.toString('base64url'),
    signatureB64: rsToDer(sig).toString('base64url')
  };

  const vote = await post('/api/vote/passkey', {
    teamId, text, nonce: ch.nonce, deadline: ch.deadline, assertion
  });
  check('指纹投票走完整链路成功', !!vote.txHash,
    'tx=' + vote.txHash + ' elapsed=' + vote.elapsedMs + 'ms');
  check('服务端回报由 0x0100 链上验签',
    (vote.verifiedBy || '').includes('0x0100'), vote.verifiedBy);

  const afterVote = await get('/api/state');
  check('同一份内容双写到中心化库',
    afterVote.central.entries.some((e) => e.text === text));

  // 先等右栏把新票读出来并带上交易哈希，避免把「轮询延迟」误判成「篡改影响」
  let voteOnChain = null;
  for (let i = 0; i < 30; i++) {
    const s = await get('/api/state');
    voteOnChain = s.chain.entries.find((e) => e.text === text && e.txHash);
    if (voteOnChain) break;
    await sleep(500);
  }
  check('右栏在 15 秒内出现新票且带交易哈希', !!voteOnChain,
    voteOnChain ? 'tx=' + voteOnChain.txHash : 'timeout');

  // 4) 篡改对照：只改左栏，右栏必须不变
  const before = await get('/api/state');
  const chainBefore = JSON.stringify(before.chain.votes);
  await post('/api/central/tamper', { op: 'setVotes', payload: { teamId, value: 999 } });
  await post('/api/central/tamper', {
    op: 'editText', payload: { id: before.central.entries[0].id, text: '被管理员改过' }
  });
  await sleep(1500);
  const after = await get('/api/state');
  check('管理页改票数立刻生效（左栏）', after.central.votes[String(teamId)] === 999,
    'votes=' + after.central.votes[String(teamId)]);
  check('管理页改文字立刻生效（左栏）',
    after.central.entries.some((e) => e.text === '被管理员改过'));
  check('链上票数完全不受篡改影响（右栏）',
    JSON.stringify(after.chain.votes) === chainBefore,
    'before=' + chainBefore + ' after=' + JSON.stringify(after.chain.votes));
  check('链上读到了刚才那笔指纹投票',
    after.chain.entries.some((e) => e.text === text),
    'chain entries=' + after.chain.entries.length);
  check('右栏带可点开的交易哈希',
    after.chain.entries.some((e) => /^0x[0-9a-fA-F]{64}$/.test(e.txHash || '')));

  // 5) 一次性 challenge 防重放（HTTP 层）
  try {
    await post('/api/vote/passkey', {
      teamId, text, nonce: ch.nonce, deadline: ch.deadline, assertion
    });
    check('同一 challenge 重放被服务端拒绝', false, '意外通过');
  } catch (e) {
    check('同一 challenge 重放被服务端拒绝', true, e.message.slice(0, 120));
  }

  const failed = results.filter((x) => !x).length;
  console.log('\n=== HTTP SELFTEST ' + (failed ? 'FAILED' : 'PASSED') +
    ' (' + (results.length - failed) + '/' + results.length + ') ===');
  if (failed) process.exit(1);
};

main().catch((e) => { console.error('HTTP SELFTEST ERROR:', e.message); process.exit(1); });
