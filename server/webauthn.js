import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { keccak256, encodePacked, toBytes, toHex } from 'viem';
import { rootDir, config, CHAIN_ID, webAuthnParams } from './config.js';

const subtle = webcrypto.subtle;
const CRED_PATH = path.join(rootDir, 'credentials.json');

// ---------------------------------------------------------------------------
// 凭据库：WebAuthn 注册时保存 P-256 公钥坐标 (qx,qy)。
// 持久化到文件，服务重启后已注册的指纹仍可用。
// ---------------------------------------------------------------------------
let credentials = {};
try {
  credentials = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
} catch { /* first run */ }

function saveCredentials() {
  // 只读沙箱下降级为进程内凭据库
  try {
    fs.writeFileSync(CRED_PATH, JSON.stringify(credentials, null, 2));
  } catch (e) {
    console.warn('[webauthn] credentials.json not writable, in-memory only:', e.code || e.message);
  }
}

const b64uDecode = (s) =>
  Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (String(s).length % 4)) % 4), 'base64');
const b64uEncode = (buf) => Buffer.from(buf).toString('base64url');

const credIdHash = (rawIdBuf) => keccak256(toHex(rawIdBuf));
const pad32 = (b) => {
  let x = Buffer.from(b);
  while (x.length > 32 && x[0] === 0) x = x.subarray(1);
  const out = Buffer.alloc(32);
  x.copy(out, 32 - Math.min(32, x.length));
  return out;
};

export function registerCredential({ credIdB64, qx, qy }) {
  if (!credIdB64 || !qx || !qy) throw new Error('missing credential fields');
  const rawId = b64uDecode(credIdB64);
  const hash = credIdHash(rawId);
  credentials[hash.toLowerCase()] = {
    credIdB64, qx: String(qx), qy: String(qy),
    registeredAt: new Date().toISOString()
  };
  saveCredentials();
  return { ok: true, credIdHash: hash };
}

export function getCredential(hash) {
  return credentials[String(hash).toLowerCase()] || null;
}

export function credentialCount() {
  return Object.keys(credentials).length;
}

// ---------------------------------------------------------------------------
// 一次性 challenge。绑定 teamId / text / nonce / deadline / chainId / 合约 / 凭据，
// 与合约 passkeyChallenge() 的 abi.encodePacked 逐字节一致。
// ---------------------------------------------------------------------------
const pending = new Map();

export function issueChallenge({ teamId, text, credIdB64, rpId, origin }) {
  const team = Number(teamId);
  const msg = String(text || '').slice(0, 200);
  const rawId = b64uDecode(credIdB64);
  const credHash = credIdHash(rawId);
  const nonceBytes = randomBytes(32);
  const nonceHex = toHex(nonceBytes);
  const deadline = Math.floor(Date.now() / 1000) + 180;

  const challenge = keccak256(encodePacked(
    ['uint16', 'bytes32', 'bytes32', 'uint64', 'uint256', 'address', 'bytes32'],
    [
      team,
      keccak256(toBytes(msg)),
      nonceHex,
      BigInt(deadline),
      BigInt(CHAIN_ID),
      config.contractAddress,
      credHash
    ]
  ));

  const challengeB64 = b64uEncode(Buffer.from(challenge.slice(2), 'hex'));
  pending.set(nonceHex, {
    teamId: team, text: msg, credHash, nonceHex, deadline,
    challenge, challengeB64, rpId, origin, createdAt: Date.now()
  });
  // 清理过期项
  for (const [k, v] of pending) {
    if (Date.now() / 1000 > v.deadline + 60) pending.delete(k);
  }
  return {
    nonce: nonceHex,
    deadline,
    challenge,
    challengeB64,
    credIdHash: credHash,
    rpId,
    origin
  };
}

// ---------------------------------------------------------------------------
// assertion 校验。服务端完整验一次 P-256 签名（提前拦截坏签名、也是 L1'
// 降级方案的验签位置），合约随后再用 0x0100 预编译独立验一次。
// ---------------------------------------------------------------------------
function derToRS(der) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('bad DER sequence');
  let len = der[i++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let k = 0; k < n; k++) len = (len << 8) | der[i++];
  }
  if (der[i++] !== 0x02) throw new Error('bad DER integer (r)');
  const lr = der[i++];
  const rb = der.subarray(i, i + lr); i += lr;
  if (der[i++] !== 0x02) throw new Error('bad DER integer (s)');
  const ls = der[i++];
  const sb = der.subarray(i, i + ls); i += ls;
  const r32 = pad32(rb), s32 = pad32(sb);
  return {
    r: BigInt('0x' + r32.toString('hex')),
    s: BigInt('0x' + s32.toString('hex')),
    rawSig: Buffer.concat([r32, s32])
  };
}

const concat = (...bufs) => Buffer.concat(bufs.map((b) => Buffer.from(b)));

export async function verifyAssertion({ teamId, text, nonce, deadline, assertion }) {
  const rec = pending.get(nonce);
  if (!rec) throw new Error('challenge 不存在或已被使用（一次性）');
  pending.delete(nonce); // 无论成功失败都消费，杜绝重放
  if (Math.floor(Date.now() / 1000) > Number(deadline)) throw new Error('challenge 已过期');
  if (rec.deadline !== Number(deadline)) throw new Error('deadline 不匹配');
  if (rec.teamId !== Number(teamId) || rec.text !== String(text)) throw new Error('投票内容与 challenge 不匹配');

  const rawId = b64uDecode(assertion.credIdB64);
  const credHash = credIdHash(rawId);
  if (credHash.toLowerCase() !== rec.credHash.toLowerCase()) throw new Error('凭据不匹配');

  const cdj = b64uDecode(assertion.clientDataJSONB64);
  const cd = JSON.parse(cdj.toString('utf8'));
  if (cd.type !== 'webauthn.get') throw new Error('clientData.type 不是 webauthn.get');
  if (cd.origin !== rec.origin) throw new Error(`origin 不匹配：期望 ${rec.origin}`);
  if (cd.challenge !== rec.challengeB64) throw new Error('clientData.challenge 不匹配');

  const authData = b64uDecode(assertion.authDataB64);
  if (authData.length < 37) throw new Error('authData 过短');
  const expectedRpHash = createHash('sha256').update(rec.rpId, 'utf8').digest();
  if (!authData.subarray(0, 32).equals(expectedRpHash)) throw new Error('rpIdHash 不匹配');
  const flags = authData[32];
  if ((flags & 0x05) !== 0x05) throw new Error('需要 UP + UV（用户到场并验证指纹）');

  const cred = getCredential(credHash);
  if (!cred) throw new Error('未注册的 passkey，请先在手机页点「启用指纹」');
  const qxb = pad32(Buffer.from(String(cred.qx).replace(/^0x/, ''), 'hex'));
  const qyb = pad32(Buffer.from(String(cred.qy).replace(/^0x/, ''), 'hex'));
  const rawPub = concat(Buffer.from([4]), qxb, qyb);

  const { r, s, rawSig } = derToRS(b64uDecode(assertion.signatureB64));
  const clientHash = createHash('sha256').update(cdj).digest();
  const signedBytes = concat(authData, clientHash);
  let offchainOk = false;
  try {
    const key = await subtle.importKey(
      'raw', rawPub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    );
    offchainOk = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, rawSig, signedBytes
    );
  } catch (e) {
    throw new Error('服务端验签异常：' + e.message);
  }
  if (!offchainOk) throw new Error('P-256 签名无效（服务端预检未通过）');

  return {
    authDataHex: toHex(authData),
    clientDataJSONHex: toHex(cdj),
    r: r.toString(), s: s.toString(),
    qx: BigInt('0x' + qxb.toString('hex')).toString(),
    qy: BigInt('0x' + qyb.toString('hex')).toString(),
    teamId: Number(teamId),
    text: String(text),
    nonceHex: nonce,
    deadline: Number(deadline),
    credIdHashHex: credHash,
    sigDigest: keccak256(toHex(rawSig)),
    rpIdHash: toHex(expectedRpHash)
  };
}
