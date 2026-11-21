import express from 'express';
import path from 'node:path';
import QRCode from 'qrcode';
import {
  config, teams, teamById, rootDir, PORT, EXPLORER, FAUCET_URL
} from './config.js';
import * as central from './central.js';
import * as chain from './chain.js';
import * as wa from './webauthn.js';

const app = express();
app.set('trust proxy', true); // 反代后仍能拿到真实的 https 与 host
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(rootDir, 'public'), { maxAge: 0 }));

// ---------------------------------------------------------------------------
// SSE：左栏推中心化库、右栏推链上事件。两个来源严格分离。
// ---------------------------------------------------------------------------
const clients = new Set();
function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}
function snapshot() {
  return {
    central: central.getState(),
    chain: { entries: chain.chainFeed, votes: chain.chainVotes() },
    meta: {
      contractAddress: config.contractAddress,
      explorer: EXPLORER,
      chainId: config.chainId,
      rpId: config.rpId
    }
  };
}

const protoOf = (req) =>
  String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
const hostOf = (req) =>
  String(req.headers['x-forwarded-host'] || req.get('host') || config.rpId).split(',')[0].trim();
const originOf = (req) => `${protoOf(req)}://${hostOf(req)}`;
const rpIdOf = (req) => hostOf(req).split(':')[0];
const absUrl = (req, p) => `${originOf(req)}${p}`;
const validTeam = (id) => teamById.has(Number(id));

app.get('/', (req, res) => res.redirect('/screen.html'));

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  clients.add(res);
  res.write('retry: 2000\n\n');
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 20000);
  req.on('close', () => { clearInterval(hb); clients.delete(res); });
});

// ---------------------------------------------------------------------------
// 配置与状态
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => res.json({
  projectName: config.projectName,
  subtitle: config.subtitle,
  chainId: config.chainId,
  contractAddress: config.contractAddress,
  deployTxHash: config.deployTxHash,
  explorer: EXPLORER,
  rpc: config.rpc,
  faucet: FAUCET_URL,
  rpId: rpIdOf(req),
  origin: originOf(req),
  baseUrl: originOf(req),
  teams,
  relayer: chain.relayerAddress(),
  registeredPasskeys: wa.credentialCount(),
  urls: {
    screen: absUrl(req, '/screen.html'),
    vote: absUrl(req, '/vote.html'),
    admin: absUrl(req, '/admin.html')
  }
}));

app.get('/api/state', (req, res) => res.json(snapshot()));
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/api/status', async (req, res) => res.json(await chain.chainStatus()));

// 二维码始终按当前请求的 host 生成 -> 线上部署后自动指向线上，不会残留 localhost
app.get('/api/qr.svg', async (req, res) => {
  const p = String(req.query.u || '/vote.html');
  const url = p.startsWith('http') ? p : absUrl(req, p);
  try {
    const svg = await QRCode.toString(url, {
      type: 'svg', margin: 1, width: 320,
      color: { dark: '#0b0f14', light: '#ffffff' }
    });
    res.type('image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ---------------------------------------------------------------------------
// 路径 A：passkey 指纹 + 转发器代付 gas + 合约内 0x0100 验签
// ---------------------------------------------------------------------------
app.post('/api/passkey/register', (req, res) => {
  try { res.json(wa.registerCredential(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/challenge', async (req, res) => {
  try {
    await chain.ensureWebAuthnConfig(rpIdOf(req), originOf(req));
    const { teamId, text, credIdB64 } = req.body || {};
    if (!validTeam(teamId)) return res.status(400).json({ error: '无效队伍 id' });
    if (!credIdB64) return res.status(400).json({ error: '缺少 passkey 凭据，请先点「启用指纹」' });
    res.json(wa.issueChallenge({
      teamId, text, credIdB64, rpId: rpIdOf(req), origin: originOf(req)
    }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/vote/passkey', async (req, res) => {
  const started = Date.now();
  try {
    const { teamId, text, nonce, deadline, assertion } = req.body || {};
    if (!validTeam(teamId)) throw new Error('无效队伍 id');
    if (!config.contractAddress) throw new Error('合约尚未部署');
    const params = await wa.verifyAssertion({ teamId, text, nonce, deadline, assertion });
    const txHash = await chain.submitPasskeyVote(params);
    // 同一份内容双写：只有这一次写中心化库，之后左栏可被任意篡改
    const entry = central.addEntry({ teamId, text, kind: 'passkey', author: '指纹观众', txHash });
    const elapsedMs = Date.now() - started;
    broadcast('central', central.getState());
    broadcast('vote', { txHash, teamId, text, elapsedMs, path: 'passkey' });
    res.json({
      ok: true, txHash, entryId: entry.id, elapsedMs,
      explorerUrl: `${EXPLORER}/tx/${txHash}`,
      sigDigest: params.sigDigest,
      verifiedBy: 'Monad P256 precompile 0x0100 (on-chain)'
    });
  } catch (e) {
    console.error('[vote/passkey]', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// 路径 B：钱包 EIP-712 直签，用户自己付 gas（前端通过注入 provider 发交易）
// ---------------------------------------------------------------------------
app.post('/api/vote/wallet/prepare', (req, res) => {
  const { teamId, text } = req.body || {};
  if (!validTeam(teamId)) return res.status(400).json({ error: '无效队伍 id' });
  const clean = String(text || '').slice(0, 200);
  const deadline = Math.floor(Date.now() / 1000) + 180;
  res.json({
    deadline, chainId: config.chainId, contractAddress: config.contractAddress,
    typedData: chain.buildTypedData(teamId, clean, deadline)
  });
});

app.post('/api/vote/wallet/encode', (req, res) => {
  const { teamId, text, deadline, sig } = req.body || {};
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig || '')) {
    return res.status(400).json({ error: 'EIP-712 签名格式错误（应为 65 字节）' });
  }
  try {
    res.json({
      to: config.contractAddress,
      data: chain.encodeVoteCalldata(teamId, String(text || '').slice(0, 200), deadline, sig),
      chainIdHex: '0x' + config.chainId.toString(16)
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/vote/wallet/confirm', (req, res) => {
  const { teamId, text, txHash } = req.body || {};
  if (!validTeam(teamId)) return res.status(400).json({ error: '无效队伍 id' });
  if (txHash) chain.noteTxStart(txHash);
  const entry = central.addEntry({ teamId, text, kind: 'wallet', author: '钱包用户', txHash });
  broadcast('central', central.getState());
  res.json({ ok: true, entryId: entry.id, txHash });
});

// ---------------------------------------------------------------------------
// 中心化库：提交时写入 + 管理页篡改（现场钩子）
// ---------------------------------------------------------------------------
app.post('/api/central/vote', (req, res) => {
  const { teamId, text, kind, txHash } = req.body || {};
  if (!validTeam(teamId)) return res.status(400).json({ error: '无效队伍 id' });
  const entry = central.addEntry({ teamId, text, kind: kind || 'manual', txHash });
  broadcast('central', central.getState());
  res.json({ ok: true, entry });
});

app.post('/api/central/tamper', (req, res) => {
  try {
    const { op, payload } = req.body || {};
    const out = central.tamper(op, payload || {});
    broadcast('central', out.state);
    broadcast('tamper', out.note);
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/central/reset', (req, res) => {
  const state = central.reset();
  broadcast('central', state);
  res.json(state);
});

app.post('/api/central/seed', (req, res) => {
  const ids = (req.body?.teamIds || []).map(Number).filter(validTeam);
  const state = central.seed(ids);
  broadcast('central', state);
  res.json(state);
});

// ---------------------------------------------------------------------------
// 链上轮询：1.5 秒一次，读 Voted 事件（自带交易哈希），推给大屏右栏
// ---------------------------------------------------------------------------
let polling = false;
setInterval(async () => {
  if (polling || !config.contractAddress) return;
  polling = true;
  try {
    const fresh = await chain.pollChain();
    if (fresh.length) {
      broadcast('chain', { entries: chain.chainFeed, votes: chain.chainVotes(), fresh });
      for (const f of fresh) {
        broadcast('vote', {
          txHash: f.txHash, teamId: f.teamId, text: f.text,
          elapsedMs: f.confirmedMs, path: 'chain'
        });
      }
    }
  } catch (e) {
    console.warn('[poll]', (e.shortMessage || e.message || '').slice(0, 160));
  } finally { polling = false; }
}, 1500);

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[uneditable] listening on 0.0.0.0:${PORT}`);
  console.log(`[uneditable] project=${config.projectName} contract=${config.contractAddress || 'NOT DEPLOYED'}`);
  console.log(`[uneditable] rpId=${config.rpId} origin=${config.origin}`);
  try {
    const st = await chain.chainStatus();
    console.log('[uneditable] chain status:', JSON.stringify(st));
  } catch (e) {
    console.warn('[uneditable] chain status unavailable:', e.message);
  }
});
