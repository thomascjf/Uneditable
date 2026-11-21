// 把合约的 WebAuthn rpIdHash / origin 复位到公开域名并锁定，
// 防止反向代理的内部 host 污染 passkey 配置。绝不打印私钥内容。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, http, defineChain,
  sha256, toBytes, toHex
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const art = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/BlitzBoard.json'), 'utf8'));

const raw = fs.readFileSync(path.join(root, '.workbuddy', 'deploy-key.txt'), 'utf8').trim();
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error('relayer key format invalid');
const account = privateKeyToAccount(raw.startsWith('0x') ? raw : '0x' + raw);

const chain = defineChain({
  id: cfg.chainId, name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } }, testnet: true
});
const transport = http(cfg.rpc, { timeout: 30000, retryCount: 3 });
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });
const ADDR = cfg.contractAddress;
const read = (functionName) => pub.readContract({ address: ADDR, abi: art.abi, functionName });

const expectedHash = sha256(toBytes(cfg.rpId));
const expectedNeedle = toHex(new TextEncoder().encode('"origin":"' + cfg.origin + '"'));
console.log('public rpId   :', cfg.rpId);
console.log('public origin :', cfg.origin);
console.log('expected hash :', expectedHash);

const curHash = await read('rpIdHash');
const curNeedle = await read('originNeedle');
const locked = await read('configLocked');
console.log('on-chain hash :', curHash);
console.log('on-chain needle matches:', curNeedle.toLowerCase() === expectedNeedle.toLowerCase());
console.log('configLocked  :', locked);

const mismatch = curHash.toLowerCase() !== expectedHash.toLowerCase() ||
  curNeedle.toLowerCase() !== expectedNeedle.toLowerCase();

if (mismatch) {
  if (locked) throw new Error('配置已锁定但与公开域名不一致，需要人工处理');
  const hash = await wallet.writeContract({
    address: ADDR, abi: art.abi, functionName: 'configure',
    args: [expectedHash, expectedNeedle], gas: 200000n, account
  });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 90000 });
  console.log('configure tx :', hash, '| status:', r.status);
  if (r.status !== 'success') throw new Error('configure reverted');
}

if (!(await read('configLocked'))) {
  const hash2 = await wallet.writeContract({
    address: ADDR, abi: art.abi, functionName: 'lockConfig',
    args: [], gas: 100000n, account
  });
  const r2 = await pub.waitForTransactionReceipt({ hash: hash2, timeout: 90000 });
  console.log('lockConfig tx:', hash2, '| status:', r2.status);
}

console.log('FINAL rpIdHash :', await read('rpIdHash'));
console.log('FINAL locked   :', await read('configLocked'));
console.log('FINAL needle   :', await read('originNeedle'));
