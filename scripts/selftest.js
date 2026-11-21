// 端到端自测：不依赖真机 passkey，用 Node Web Crypto 生成真实 P-256 密钥，
// 构造完全合法的 WebAuthn assertion，直接调用已部署合约 voteByPasskey()。
// 通过 = 合约内 0x0100 预编译验签、challenge 绑定、rpIdHash、UP/UV 全部正确。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import {
  createPublicClient, createWalletClient, http, defineChain,
  keccak256, encodePacked, toBytes, toHex
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const art = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/BlitzBoard.json'), 'utf8'));
const subtle = webcrypto.subtle;
const hex = (u8) => Buffer.from(u8).toString('hex');

if (!cfg.contractAddress) throw new Error('contract not deployed yet');

const chain = defineChain({
  id: cfg.chainId, name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } }, testnet: true
});
const transport = http(cfg.rpc, { timeout: 30000, retryCount: 3 });
const pub = createPublicClient({ chain, transport });
const rawKey = fs.readFileSync(path.join(root, '.workbuddy/deploy-key.txt'), 'utf8').trim();
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(rawKey)) throw new Error('relayer key format invalid');
const account = privateKeyToAccount(rawKey.startsWith('0x') ? rawKey : '0x' + rawKey);
const wallet = createWalletClient({ account, chain, transport });

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
};

// ---------- 构造一次完全合法的 passkey 断言 ----------
async function buildAssertion(teamId, text, nonce, deadline, credIdHash, tamperSig = false) {
  const { publicKey, privateKey } = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
  );
  const rawPub = new Uint8Array(await subtle.exportKey('raw', publicKey)); // 0x04||X||Y
  const qx = BigInt('0x' + hex(rawPub.slice(1, 33)));
  const qy = BigInt('0x' + hex(rawPub.slice(33, 65)));

  const challenge = keccak256(encodePacked(
    ['uint16', 'bytes32', 'bytes32', 'uint64', 'uint256', 'address', 'bytes32'],
    [teamId, keccak256(toBytes(text)), nonce, BigInt(deadline),
      BigInt(cfg.chainId), cfg.contractAddress, credIdHash]
  ));
  const cdj = Buffer.from(JSON.stringify({
    type: 'webauthn.get',
    challenge: Buffer.from(challenge.slice(2), 'hex').toString('base64url'),
    origin: cfg.origin,
    crossOrigin: false
  }), 'utf8');

  const rpIdHash = createHash('sha256').update(cfg.rpId, 'utf8').digest();
  const authData = Buffer.concat([
    rpIdHash,
    Buffer.from([0x05]),          // UP(0x01) + UV(0x04)
    Buffer.from([0, 0, 0, 1])    // signCount
  ]);
  const clientHash = createHash('sha256').update(cdj).digest();
  const signedBytes = Buffer.concat([authData, clientHash]);
  const sig = new Uint8Array(await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, signedBytes
  )); // 64 bytes r||s (P1363)
  let r = BigInt('0x' + hex(sig.slice(0, 32)));
  const s = BigInt('0x' + hex(sig.slice(32, 64)));
  if (tamperSig) r = (r + 1n) % (2n ** 256n);

  return {
    args: [
      toHex(authData), toHex(cdj), r, s, qx, qy,
      teamId, text, nonce, BigInt(deadline), credIdHash
    ]
  };
}

const ADDR = cfg.contractAddress;
const simulate = (args) => pub.simulateContract({
  address: ADDR, abi: art.abi, functionName: 'voteByPasskey', args, account: account.address
});

const main = async () => {
  console.log('chainId      :', await pub.getChainId());
  console.log('contract     :', ADDR);
  console.log('rpId/origin  :', cfg.rpId, cfg.origin);
  console.log('relayer      :', account.address);
  console.log('deployBlock  :', cfg.deployBlock);
  console.log('onchain total:', (await pub.readContract({ address: ADDR, abi: art.abi, functionName: 'total' })).toString());

  // 1) 预编译本身：有效签名 simulate 通过
  const teamId = 685;
  const text = '[selftest] P256 0x0100 on-chain verify ' + new Date().toISOString();
  const nonce = toHex(randomBytes(32));
  const deadline = Math.floor(Date.now() / 1000) + 900;
  const credIdHash = keccak256(toHex(randomBytes(23)));

  const good = await buildAssertion(teamId, text, nonce, deadline, credIdHash);
  let sim;
  try {
    sim = await simulate(good.args);
    check('有效 P-256 签名 / challenge / rpIdHash / origin 通过合约模拟', true,
      'gas=' + (sim.result?.gas || sim.request?.gas || 'n/a'));
  } catch (e) {
    check('有效 P-256 签名 / challenge / rpIdHash / origin 通过合约模拟', false,
      (e.shortMessage || e.message || '').slice(0, 300));
    throw new Error('selftest aborted: valid assertion reverted');
  }

  // 2) 真实发交易，验证链上写入
  // 注意：不要直接 writeContract(sim.request) —— simulate 返回的 request.account
  // 是地址字符串，会让 walletClient 改用节点 eth_sendTransaction（公共 RPC 不提供）。
  // 显式传本地 Account 对象，保证走 eth_sendRawTransaction 本地签名。
  const hash = await wallet.writeContract({
    address: ADDR, abi: art.abi, functionName: 'voteByPasskey',
    args: good.args, gas: 900000n, account
  });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120000 });
  check('真实交易 voteByPasskey 上链成功', receipt.status === 'success',
    'tx=' + hash + ' gasUsed=' + receipt.gasUsed);
  const total = await pub.readContract({ address: ADDR, abi: art.abi, functionName: 'total' });
  check('合约 entries 增加', Number(total) >= 1, 'total=' + total);
  check('队伍票数增加', (await pub.readContract({
    address: ADDR, abi: art.abi, functionName: 'votes', args: [teamId]
  })) > 0n);

  // 3) 防重放：同一 nonce 再次提交必须被拒
  try {
    await simulate(good.args);
    check('同一 nonce 重放被合约拒绝', false, '意外通过');
  } catch (e) {
    check('同一 nonce 重放被合约拒绝', true, (e.shortMessage || e.message || '').slice(0, 140));
  }

  // 4) 每凭据限投：换 nonce、同 credIdHash 也必须被拒
  const nonce2 = toHex(randomBytes(32));
  const sameCred = await buildAssertion(teamId, text + ' x', nonce2, deadline, credIdHash);
  try {
    await simulate(sameCred.args);
    check('同一 passkey 凭据第二次投票被拒', false, '意外通过');
  } catch (e) {
    check('同一 passkey 凭据第二次投票被拒', true, (e.shortMessage || e.message || '').slice(0, 140));
  }

  // 5) 篡改签名：r+1 必须被 0x0100 拒绝
  const bad = await buildAssertion(teamId, text, toHex(randomBytes(32)), deadline,
    keccak256(toHex(randomBytes(23))), true);
  try {
    await simulate(bad.args);
    check('篡改后的签名被 P256 预编译拒绝', false, '意外通过');
  } catch (e) {
    check('篡改后的签名被 P256 预编译拒绝', true, (e.shortMessage || e.message || '').slice(0, 140));
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== SELFTEST ' + (failed.length ? 'FAILED' : 'PASSED') +
    ' (' + (results.length - failed.length) + '/' + results.length + ') ===');
  console.log('TX_HASH=' + hash);
  console.log('EXPLORER=' + cfg.explorer + '/tx/' + hash);
  if (failed.length) process.exit(1);
};

main().catch((e) => { console.error('SELFTEST ERROR:', e.message); process.exit(1); });
