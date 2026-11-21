import fs from 'node:fs';
import path from 'node:path';
import { rootDir } from './config.js';

const STORE_PATH = path.join(rootDir, 'store.json');

const emptyStore = () => ({ version: 0, entries: [], votes: {}, audit: [] });

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { version: s.version || 0, entries: s.entries || [], votes: s.votes || {}, audit: s.audit || [] };
  } catch {
    return emptyStore();
  }
}

let store = load();
let seq = store.entries.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);

function persist() {
  store.version += 1;
  // 托管沙箱可能是只读文件系统；失败时降级为进程内存储，不影响演示
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  } catch (e) {
    console.warn('[central] store.json not writable, in-memory only:', e.code || e.message);
  }
}

export function getState() {
  return {
    version: store.version,
    entries: store.entries.slice(),
    votes: { ...store.votes },
    audit: store.audit.slice(-30),
    updatedAt: Date.now()
  };
}

export function reset() {
  store = emptyStore();
  seq = 0;
  persist();
  return getState();
}

/// 与链上同一份内容双写：只在提交时写一次，之后中心化栏可被任意篡改。
export function addEntry({ teamId, text, kind = 'passkey', author = '现场观众', txHash = '' }) {
  const id = ++seq;
  const entry = {
    id,
    teamId: Number(teamId),
    text: String(text || '').slice(0, 200),
    kind,
    author,
    txHash,
    timestamp: Math.floor(Date.now() / 1000)
  };
  store.entries.push(entry);
  const k = String(teamId);
  store.votes[k] = (store.votes[k] || 0) + 1;
  persist();
  return entry;
}

/// 管理页三件套：改票数 / 删留言 / 改文字。只动中心化库，链上永不触碰。
export function tamper(op, payload) {
  const note = { at: Date.now(), op, detail: '' };
  if (op === 'setVotes') {
    const teamId = Number(payload.teamId);
    const value = Math.max(0, Math.min(9999, Number(payload.value) || 0));
    store.votes[String(teamId)] = value;
    note.detail = `队伍 ${teamId} 票数改为 ${value}`;
  } else if (op === 'deleteEntry') {
    const id = Number(payload.id);
    const before = store.entries.length;
    store.entries = store.entries.filter((e) => e.id !== id);
    note.detail = `删除留言 #${id}` + (before === store.entries.length ? '（未找到）' : '');
  } else if (op === 'editText') {
    const id = Number(payload.id);
    const e = store.entries.find((x) => x.id === id);
    if (e) {
      e.text = String(payload.text || '').slice(0, 200);
      note.detail = `留言 #${id} 文字改为「${e.text}」`;
    } else note.detail = `留言 #${id} 未找到`;
  } else {
    throw new Error('unknown tamper op: ' + op);
  }
  store.audit.push(note);
  if (store.audit.length > 200) store.audit = store.audit.slice(-200);
  persist();
  return { state: getState(), note };
}

const SEED_TEXTS = [
  '第一次用指纹投票，居然真的上链了',
  '不用装钱包这一点太关键了',
  '左右两栏对照一看就懂',
  'Monad 的 P256 预编译有意思',
  '换份名单我们社团也能用',
  '现场改数据库这个演示很直观'
];

/// 空链兜底：只写中心化库的固定演示文案，保证空场也不空屏。
/// 注意：这里不写链上；现场对齐请用 alignFromChain()。
export function seed(teamIds) {
  reset();
  const ids = teamIds.length ? teamIds : [685, 684, 683, 681, 680, 679];
  SEED_TEXTS.forEach((t, i) => addEntry({
    teamId: ids[i % ids.length],
    text: t,
    kind: 'seed',
    author: '预置数据'
  }));
  return getState();
}

/// 以链上当前条目为准重建中心化库：现场点「重置并对齐链上数据」时调用。
/// 队伍 / 留言 / 时间 / 交易哈希 / 票数全部取自链上，左右两栏逐条一致。
export function alignFromChain(chainEntries) {
  const votes = {};
  const entries = (chainEntries || []).map((e) => {
    const k = String(e.teamId);
    votes[k] = (votes[k] || 0) + 1;
    return {
      id: Number(e.id) + 1,
      teamId: Number(e.teamId),
      text: String(e.text || '').slice(0, 200),
      kind: Number(e.kind) === 0 ? 'wallet' : 'passkey',
      author: Number(e.kind) === 0 ? '钱包用户' : '指纹观众',
      txHash: e.txHash || '',
      timestamp: Number(e.timestamp)
    };
  });
  seq = entries.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
  store = { version: store.version, entries, votes, audit: [] };
  persist();
  return getState();
}
