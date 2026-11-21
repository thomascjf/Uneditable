// 生成现场物料 + 整理独立 deploy/ 发布目录（凭证隔离）。
// 绝不打印任何密钥内容。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const art = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/BlitzBoard.json'), 'utf8'));
const base = cfg.baseUrl.replace(/\/$/, '');
const addr = cfg.contractAddress;

// ---------------------------------------------------------------------------
// 1) README 写入完整 ABI（可重复运行）
// ---------------------------------------------------------------------------
const readmePath = path.join(root, 'README.md');
let readme = fs.readFileSync(readmePath, 'utf8');
const START = '<!-- ABI_START -->', END = '<!-- ABI_END -->';
const section = START + '\n```json\n' + JSON.stringify(art.abi, null, 2) + '\n```\n' + END;
if (readme.includes(START) && readme.includes(END)) {
  const a = readme.indexOf(START), b = readme.indexOf(END) + END.length;
  readme = readme.slice(0, a) + section + readme.slice(b);
} else if (readme.includes('<!-- ABI_JSON_HERE -->')) {
  readme = readme.replace('<!-- ABI_JSON_HERE -->', section);
}
fs.writeFileSync(readmePath, readme);
console.log('README.md : full ABI inserted (' + art.abi.length + ' entries)');

// ---------------------------------------------------------------------------
// 2) 剪贴板预置项
// ---------------------------------------------------------------------------
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
const intro = '这是一个面向非 Web3 背景研发新人和大学生的零门槛上链入口。观众扫码、按一下指纹，10 秒就能在 Monad 测试网投出一票、留下留言，不需要装钱包、助记词或代币。换一份队伍名单，这套入口就能复用于下一场活动。大屏左栏来自中心化数据库、右栏来自 Monad 合约；现场请观众亲手改左栏的票数和留言，右栏纹丝不动，点开交易哈希即可验证——让不了解去中心化的人十秒内看懂：规则写在合约里，谁都改不了。';
let recent = [cfg.deployTxHash, '0xfc88c79bce09a86510cddae1e3c8c0eeb8017f79efafee3ced060eb3b6ae6a05'];
try {
  const s = JSON.parse(fs.readFileSync(path.join(root, 'store.json'), 'utf8'));
  const hs = (s.entries || []).map((e) => e.txHash)
    .filter((h) => /^0x[0-9a-fA-F]{64}$/.test(h || '')).reverse();
  recent = [...new Set([...hs, ...recent])].slice(0, 3);
} catch { /* no store yet */ }

const lines = [
  '# 指纹上链 · 剪贴板预置项（逐行复制，别现场打字）',
  '',
  '[项目名] 指纹上链',
  '[副标题] 按一下指纹，10 秒上链；换一份名单，下一场活动就能复用',
  '',
  '[Demo 链接] ' + base + '/',
  '[大屏] ' + base + '/screen.html',
  '[投票页] ' + base + '/vote.html',
  '[管理页] ' + base + '/admin.html',
  '',
  '[合约地址] ' + addr,
  '[合约浏览器] ' + cfg.explorer + '/address/' + addr,
  '[部署交易] ' + cfg.deployTxHash,
  '[部署交易浏览器] ' + cfg.explorer + '/tx/' + cfg.deployTxHash,
  '[转发器地址] 0xa5d28e6513766a36a3c2a00AF0966A80631Fc8E0',
  '[MonadVision] ' + cfg.explorer,
  '[水龙头] https://faucet.monad.xyz/',
  '[GitHub] https://github.com/thomascjf/Uneditable',
  '[chainId] 10143',
  '[RPC] ' + cfg.rpc,
  '',
  '[最近交易哈希]',
  ...recent.map((h, i) => '  ' + (i + 1) + '. ' + h + '\n     ' + cfg.explorer + '/tx/' + h),
  '',
  '[Mojo 提交简介] ' + intro,
  '',
  '[一句话钩子] 没碰过钱包的人，10 秒投一票；这一票，谁都改不掉。',
  '[收尾] 换一份队伍名单，下一场活动、校园选举、会议表决，直接拿来用。'
];
fs.writeFileSync(path.join(root, 'assets', 'clipboard.txt'), lines.join('\n') + '\n');
console.log('assets/clipboard.txt : generated');

// ---------------------------------------------------------------------------
// 3) 独立 deploy/ 目录：只放运行必需文件
//    排除 .mojo/、.workbuddy/、other-docs/、docs/、scripts/、.git/
//    唯一例外：relayer.key（无真实资产的一次性测试网钱包）
// ---------------------------------------------------------------------------
const dep = path.join(root, 'deploy');
fs.rmSync(dep, { recursive: true, force: true });
for (const d of ['server', 'public', 'artifacts']) fs.mkdirSync(path.join(dep, d), { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({
  name: 'uneditable', version: '1.0.0', private: true, type: 'module',
  description: '指纹上链 · 零门槛上链入口（Monad Blitz@广州）',
  scripts: { start: 'node server/index.js' },
  dependencies: pkg.dependencies, engines: pkg.engines
}, null, 2) + '\n');

for (const f of ['config.json', 'teams.json']) {
  fs.copyFileSync(path.join(root, f), path.join(dep, f));
}
for (const f of fs.readdirSync(path.join(root, 'server')).filter((x) => x.endsWith('.js'))) {
  fs.copyFileSync(path.join(root, 'server', f), path.join(dep, 'server', f));
}
for (const f of fs.readdirSync(path.join(root, 'public'))) {
  fs.copyFileSync(path.join(root, 'public', f), path.join(dep, 'public', f));
}
fs.copyFileSync(path.join(root, 'artifacts', 'BlitzBoard.json'), path.join(dep, 'artifacts', 'BlitzBoard.json'));
fs.writeFileSync(path.join(dep, 'store.json'), JSON.stringify({ version: 0, entries: [], votes: {}, audit: [] }, null, 2));

// 唯一允许随发布上传的密钥；只校验格式，绝不打印内容
const rawKey = fs.readFileSync(path.join(root, '.workbuddy', 'deploy-key.txt'), 'utf8').trim();
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(rawKey)) throw new Error('relayer key format invalid');
fs.writeFileSync(path.join(dep, 'relayer.key'), rawKey + '\n', { mode: 0o600 });

// 安全自检：deploy/ 里不能出现其它敏感目录或密钥文件
const forbidden = ['.mojo', '.workbuddy', 'other-docs', 'docs', 'scripts', '.git', 'deploy-key.txt', 'agent.json'];
const found = [];
const walk = (dir, rel = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (forbidden.includes(e.name)) found.push(r);
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
  }
};
walk(dep);
if (found.length) throw new Error('deploy/ contains forbidden items: ' + found.join(', '));

const list = [];
const collect = (dir, rel = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) collect(path.join(dir, e.name), r);
    else list.push(r);
  }
};
collect(dep);
console.log('deploy/ : ' + list.length + ' files (secrets isolated, self-check OK)');
for (const f of list) console.log('  ' + f + (f === 'relayer.key' ? '   <- one-time testnet key only' : ''));
