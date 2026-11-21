// 生成现场三张（+1 备用）二维码物料 PNG，全部指向 config.baseUrl 的线上域名。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const outDir = path.join(root, 'assets');
fs.mkdirSync(outDir, { recursive: true });

const base = cfg.baseUrl.replace(/\/$/, '');
const withCode = (u) => cfg.shareCode
  ? u + (u.includes('?') ? '&' : '?') + 'sharecode=' + encodeURIComponent(cfg.shareCode)
  : u;
const items = [
  { file: 'qr-vote.png', url: withCode(base + '/vote.html'), label: '投票页' },
  { file: 'qr-admin.png', url: withCode(base + '/admin.html'), label: '后台管理（现场篡改）' },
  { file: 'qr-faucet.png', url: 'https://faucet.monad.xyz/', label: '测试网水龙头' },
  { file: 'qr-screen.png', url: withCode(base + '/screen.html'), label: '大屏（备用）' }
];

for (const it of items) {
  await QRCode.toFile(path.join(outDir, it.file), it.url, {
    width: 640, margin: 2,
    color: { dark: '#0b0f14', light: '#ffffff' },
    errorCorrectionLevel: 'M'
  });
  console.log(it.file.padEnd(16), it.label.padEnd(22), it.url);
}
fs.writeFileSync(path.join(outDir, 'qr-urls.txt'),
  items.map((i) => `${i.label}\t${i.url}`).join('\n') + '\n');
console.log('\nbaseUrl =', base, '| 如域名有变，改 config.json 后重跑 npm run qr');
