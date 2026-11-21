import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createWalletClient, createPublicClient, http, defineChain,
  sha256, toBytes, toHex, formatEther
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfgPath = path.join(root, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const art = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/BlitzBoard.json'), 'utf8'));

// 只校验格式，绝不打印私钥内容
const raw = fs.readFileSync(path.join(root, '.workbuddy/deploy-key.txt'), 'utf8').trim();
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error('relayer key format invalid');
const key = raw.startsWith('0x') ? raw : '0x' + raw;
const account = privateKeyToAccount(key);

const chain = defineChain({
  id: cfg.chainId,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
  blockExplorers: { default: { name: 'MonadVision', url: cfg.explorer } },
  testnet: true
});
const transport = http(cfg.rpc, { timeout: 30000, retryCount: 3 });
const wallet = createWalletClient({ account, chain, transport });
const pub = createPublicClient({ chain, transport });

console.log('relayer address :', account.address, '(public, receive-only; NOT the private key)');
console.log('relayer balance :', formatEther(await pub.getBalance({ address: account.address })), 'MON');
console.log('chainId         :', await pub.getChainId());

const originNeedle = '"origin":"' + cfg.origin + '"';
const rpIdHash = sha256(toBytes(cfg.rpId));
const originNeedleHex = toHex(new TextEncoder().encode(originNeedle));
console.log('rpId            :', cfg.rpId);
console.log('origin          :', cfg.origin);

const hash = await wallet.deployContract({
  abi: art.abi,
  bytecode: art.bytecode,
  args: [rpIdHash, originNeedleHex]
});
console.log('deploy tx       :', hash);
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180000 });
if (receipt.status !== 'success' || !receipt.contractAddress) {
  throw new Error('deployment failed: ' + JSON.stringify({ status: receipt.status, gasUsed: receipt.gasUsed }));
}

cfg.contractAddress = receipt.contractAddress;
cfg.deployTxHash = hash;
cfg.deployBlock = Number(receipt.blockNumber);
cfg.deployedAt = new Date().toISOString();
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

console.log('CONTRACT_ADDRESS=' + receipt.contractAddress);
console.log('DEPLOY_TX=' + hash);
console.log('EXPLORER=' + cfg.explorer + '/address/' + receipt.contractAddress);
console.log('gasUsed=' + receipt.gasUsed.toString());
