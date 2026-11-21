import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient, createWalletClient, http, defineChain,
  toHex, formatEther, parseAbiItem,
  encodeFunctionData
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config, abi, rootDir, webAuthnParams, CHAIN_ID } from './config.js';

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [config.rpc] } },
  blockExplorers: { default: { name: 'MonadVision', url: config.explorer } },
  testnet: true
});
const transport = http(config.rpc, { timeout: 20000, retryCount: 2 });
export const pub = createPublicClient({ chain, transport });

// ---------------------------------------------------------------------------
// 转发器钱包。私钥只从本地文件读取，绝不打印、绝不入库、绝不返回给前端。
// deploy/ 目录下为 relayer.key；本地开发回退到 .workbuddy/deploy-key.txt。
// ---------------------------------------------------------------------------
let cached = null;
export function getRelayer() {
  if (cached) return cached;
  const candidates = [
    path.join(rootDir, config.relayerKeyFile || 'relayer.key'),
    path.join(rootDir, '.workbuddy', 'deploy-key.txt')
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) throw new Error('relayer key file missing (expected relayer.key)');
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error('relayer key format invalid');
  const account = privateKeyToAccount(raw.startsWith('0x') ? raw : '0x' + raw);
  const wallet = createWalletClient({ account, chain, transport });
  cached = { account, wallet, keyFile: path.basename(file) };
  return cached;
}

export const relayerAddress = () => getRelayer().account.address;
export async function relayerBalance() {
  return formatEther(await pub.getBalance({ address: relayerAddress() }));
}

// 单飞队列：现场并发投票时避免 nonce 冲突
let tail = Promise.resolve();
export function serialized(fn) {
  const run = () => Promise.resolve().then(fn);
  const p = tail.then(run, run);
  tail = p.then(() => {}, () => {});
  return p;
}

const ADDRESS = () => config.contractAddress;
const read = (functionName, args = []) =>
  pub.readContract({ address: ADDRESS(), abi, functionName, args });

// ---------------------------------------------------------------------------
// 交易索引：entryId -> { txHash, blockNumber, gasUsed, status, from }
// knownTx 是纯内存，服务重启后历史条目的交易哈希会丢失，右栏就会全部指向
// 同一个空链接。这里用链上 Voted 事件回填完整索引，并缓存到 chain-tx.json，
// 让重启也能秒级恢复；缓存不全时才按 100 块窗口分段扫描全链。
// ---------------------------------------------------------------------------
const VOTED_EVENT = parseAbiItem(
  'event Voted(uint256 indexed id, uint8 kind, uint16 indexed teamId, address indexed author, bytes32 credHash, string text, uint64 timestamp, bytes32 nonce)'
);
const TX_CACHE_FILE = path.join(rootDir, 'chain-tx.json');
const txIndex = new Map();
let backfilled = false;

const txFields = (x) => ({
  id: x.id,
  txHash: x.txHash ?? null,
  blockNumber: x.blockNumber ?? null,
  gasUsed: x.gasUsed ?? null,
  status: x.status ?? null,
  from: x.from ?? null
});

function loadTxCache() {
  try {
    const arr = JSON.parse(fs.readFileSync(TX_CACHE_FILE, 'utf8'));
    for (const x of arr) if (x && Number.isInteger(x.id) && x.txHash) txIndex.set(x.id, txFields(x));
  } catch { /* 首次启动 / 只读沙箱：靠链上回填 */ }
}
export function saveTxCache() {
  try {
    fs.writeFileSync(TX_CACHE_FILE, JSON.stringify([...txIndex.values()], null, 2));
  } catch (e) {
    console.warn('[chain] tx cache not writable:', e.code || e.message);
  }
}
loadTxCache();

const indexOf = (id) => txIndex.has(id) ? txFields(txIndex.get(id)) : null;
function remember(item) {
  const next = { ...(txIndex.get(item.id) || { id: item.id }) };
  for (const k of ['txHash', 'blockNumber', 'gasUsed', 'status', 'from']) {
    if (item[k] !== null && item[k] !== undefined) next[k] = item[k];
  }
  next.id = item.id;
  txIndex.set(item.id, next);
}

export async function backfillTxIndex() {
  if (backfilled || !ADDRESS()) return;
  const latest = await pub.getBlockNumber();
  const total = Number(await read('total'));
  // 缓存已覆盖全部条目且带交易详情时，无需再扫链
  const complete = total > 0 && Array.from({ length: total }, (_, i) => i)
    .every((i) => { const x = txIndex.get(i); return x && x.txHash && x.gasUsed; });
  if (complete) { backfilled = true; return; }

  let start = BigInt(config.deployBlock || 0);
  if (!config.deployBlock) {
    // 配置缺部署区块时，从部署交易回执反查；再兜底只扫最近 2 万块，
    // 绝不能从创世块开始扫（公共 RPC 会被打爆）。
    try {
      start = (await pub.getTransactionReceipt({ hash: config.deployTxHash })).blockNumber;
    } catch {
      start = latest > 20000n ? latest - 20000n : 0n;
    }
  }
  const SPAN = 100n;       // Monad 公共 RPC：120 块起报 block range too large
  const CONCURRENCY = 6;
  const MAX_SEGMENTS = 220;
  let segments = [];
  for (let b = start; b <= latest; b += SPAN) {
    segments.push([b, b + SPAN - 1n > latest ? latest : b + SPAN - 1n]);
  }
  if (segments.length > MAX_SEGMENTS) segments = segments.slice(-MAX_SEGMENTS);
  let found = 0;
  for (let i = 0; i < segments.length; i += CONCURRENCY) {
    const batch = await Promise.all(segments.slice(i, i + CONCURRENCY).map(([f, t]) =>
      pub.getLogs({ address: ADDRESS(), event: VOTED_EVENT, fromBlock: f, toBlock: t }).catch(() => [])
    ));
    for (const logs of batch) for (const l of logs) {
      const id = l.args?.id === undefined ? null : Number(l.args.id);
      if (id === null || txIndex.has(id)) continue;
      txIndex.set(id, txFields({ id, txHash: l.transactionHash, blockNumber: Number(l.blockNumber) }));
      found++;
    }
  }
  if (found) saveTxCache();
  backfilled = true;
  console.log('[chain] tx index backfilled:', txIndex.size, 'tx (new ' + found + ')');
}

// 用交易回执补齐 gasUsed / status / from，每个条目只尝试一次
export async function enrichReceipts(items) {
  const need = items.filter((x) => x.txHash && !x.gasUsed && !x.receiptTried).slice(0, 24);
  if (!need.length) return [];
  const updated = [];
  await Promise.all(need.map(async (x) => {
    x.receiptTried = true;
    try {
      const r = await pub.getTransactionReceipt({ hash: x.txHash });
      x.blockNumber = x.blockNumber ?? Number(r.blockNumber);
      x.gasUsed = String(r.gasUsed);
      x.status = r.status;
      x.from = r.from;
      remember(x);
      updated.push(x);
    } catch { /* 保留日志里已有的哈希与区块 */ }
  }));
  if (updated.length) saveTxCache();
  return updated;
}

// ---------------------------------------------------------------------------
// WebAuthn 域名绑定：服务启动时按真实 host 一次性同步到合约并可选锁定。
// 换域名只需改 config.json 的 rpId/origin，不需要重新部署合约。
// ---------------------------------------------------------------------------
let syncedFor = null;
export async function ensureWebAuthnConfig(rpId, origin) {
  if (!ADDRESS()) return null;
  const p = webAuthnParams(rpId, origin);
  if (syncedFor === p.rpId + '|' + p.origin) return p;
  // 本地开发不要把 localhost 写进链上配置，更不要因此锁定域名
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(p.rpId)) return p;
  const onchain = await read('rpIdHash');
  const locked = await read('configLocked');
  if (onchain.toLowerCase() !== p.rpIdHash.toLowerCase() && !locked) {
    const { wallet } = getRelayer();
    await serialized(async () => {
      const hash = await wallet.writeContract({
        address: ADDRESS(), abi, functionName: 'configure',
        args: [p.rpIdHash, p.originNeedleHex], gas: 200000n
      });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 60000 });
      if (r.status !== 'success') throw new Error('configure reverted');
    });
    console.log('[chain] WebAuthn rpId/origin synced ->', p.rpId);
  }
  if (config.lockConfigAfterSync && !locked) {
    const { wallet } = getRelayer();
    await serialized(async () => {
      const hash = await wallet.writeContract({
        address: ADDRESS(), abi, functionName: 'lockConfig', args: [], gas: 100000n
      });
      await pub.waitForTransactionReceipt({ hash, timeout: 60000 });
    });
    console.log('[chain] WebAuthn config locked');
  }
  syncedFor = p.rpId + '|' + p.origin;
  return p;
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------
export function encodeVoteCalldata(teamId, text, deadline, sig) {
  return encodeFunctionData({
    abi, functionName: 'vote',
    args: [Number(teamId), String(text), BigInt(deadline), sig]
  });
}

export function buildTypedData(teamId, text, deadline) {
  return {
    domain: {
      name: 'Uneditable', version: '1', chainId: CHAIN_ID,
      verifyingContract: ADDRESS()
    },
    primaryType: 'Vote',
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' }
      ],
      Vote: [
        { name: 'teamId', type: 'uint16' },
        { name: 'text', type: 'string' },
        { name: 'deadline', type: 'uint64' }
      ]
    },
    message: { teamId: Number(teamId), text: String(text), deadline: Number(deadline) }
  };
}

const txStarted = new Map();
// 转发器自己发出的交易直接记账 entryId -> txHash，不依赖 eth_getLogs 的窗口
const knownTx = new Map();
export function noteTxStart(hash) {
  txStarted.set(hash.toLowerCase(), Date.now());
}

export async function submitPasskeyVote(p) {
  const { wallet } = getRelayer();
  const args = [
    p.authDataHex, p.clientDataJSONHex,
    BigInt(p.r), BigInt(p.s), BigInt(p.qx), BigInt(p.qy),
    Number(p.teamId), String(p.text),
    p.nonceHex, BigInt(p.deadline), p.credIdHashHex
  ];
  return serialized(async () => {
    const hash = await wallet.writeContract({
      address: ADDRESS(), abi, functionName: 'voteByPasskey',
      args, gas: 900000n
    });
    noteTxStart(hash);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90000 });
    if (receipt.status !== 'success') {
      throw new Error('voteByPasskey reverted on-chain (check P256 / challenge / rpIdHash)');
    }
    try {
      const total = Number(await read('total'));
      if (total > 0) {
        knownTx.set(total - 1, hash);
        remember({ id: total - 1, txHash: hash });
        saveTxCache();
      }
    } catch { /* getLogs 会兜底补哈希 */ }
    return hash;
  });
}

// ---------------------------------------------------------------------------
// 链上读取：total() + getEntry(i) 为主，交易索引 / 事件 / 回执补齐元数据。
// ---------------------------------------------------------------------------
export const chainFeed = [];

export async function pollChain() {
  if (!ADDRESS()) return [];
  const latest = await pub.getBlockNumber();
  await backfillTxIndex();          // 首次启动回填全部历史交易（有缓存时几乎零成本）

  const total = Number(await read('total'));
  const fresh = [];
  for (let i = chainFeed.length; i < total; i++) {
    const e = await read('getEntry', [BigInt(i)]);
    const idx = indexOf(i);
    const hash = knownTx.get(i) || idx?.txHash || null;
    const started = hash ? txStarted.get(hash.toLowerCase()) : null;
    const item = {
      id: i, kind: Number(e.kind), teamId: Number(e.teamId),
      author: e.author, credHash: e.credHash, text: e.text,
      timestamp: Number(e.timestamp), txHash: hash,
      blockNumber: idx?.blockNumber ?? null,
      gasUsed: idx?.gasUsed ?? null, status: idx?.status ?? null, from: idx?.from ?? null,
      confirmedMs: started ? Date.now() - started : null
    };
    chainFeed.push(item);
    fresh.push(item);
  }

  // 最近 60 块窗口：补刚上链、还没进索引的交易（RPC 上限 >60 才安全）
  const from = latest > 60n ? latest - 60n : 0n;
  try {
    const logs = await pub.getLogs({
      address: ADDRESS(), event: VOTED_EVENT, fromBlock: from, toBlock: latest
    });
    for (const l of logs) {
      const a = l.args;
      if (!a || a.id === undefined) continue;
      const item = chainFeed.find((x) => x.id === Number(a.id));
      if (!item) continue;
      let changed = false;
      if (!item.txHash) {
        item.txHash = l.transactionHash;
        item.blockNumber = Number(l.blockNumber);
        remember(item);
        changed = true;
      }
      const started = txStarted.get(l.transactionHash.toLowerCase());
      if (started && !item.confirmedMs) {
        item.confirmedMs = Date.now() - started;
        changed = true;
      }
      if (changed && !fresh.includes(item)) fresh.push(item);
    }
  } catch (e) {
    console.warn('[poll] getLogs skipped:', (e.shortMessage || e.message || '').slice(0, 100));
  }

  // 重启后从索引补齐历史条目的哈希
  for (const item of chainFeed) {
    if (!item.txHash && txIndex.has(item.id)) {
      const idx = indexOf(item.id);
      item.txHash = idx.txHash;
      item.blockNumber = idx.blockNumber;
      if (!fresh.includes(item)) fresh.push(item);
    }
  }

  const updated = await enrichReceipts(chainFeed);
  for (const item of updated) if (!fresh.includes(item)) fresh.push(item);
  return fresh;
}

export function chainVotes() {
  const v = {};
  for (const e of chainFeed) v[String(e.teamId)] = (v[String(e.teamId)] || 0) + 1;
  return v;
}

export async function chainStatus() {
  try {
    const id = await pub.getChainId();
    const total = ADDRESS() ? Number(await read('total')) : 0;
    return {
      ok: true, chainId: id, contractAddress: ADDRESS(), onchainEntries: total,
      relayer: relayerAddress(), balanceMon: await relayerBalance(),
      configuredRpId: config.rpId, configLocked: ADDRESS() ? await read('configLocked') : false
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
