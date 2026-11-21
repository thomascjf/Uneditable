import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, toBytes, toHex } from 'viem';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(rootDir, p), 'utf8'));

export const config = read('config.json');
export const teamsData = read('teams.json');
export const artifact = read('artifacts/BlitzBoard.json');
export const abi = artifact.abi;
export const teams = teamsData.teams;
export const teamById = new Map(teams.map((t) => [t.id, t]));

// 部署环境可用环境变量覆盖这三处；域名一旦定稿不要再改动（passkey rpId 绑定）
if (process.env.BASE_URL) config.baseUrl = process.env.BASE_URL.replace(/\/$/, '');
if (process.env.RP_ID) {
  config.rpId = process.env.RP_ID;
  config.origin = process.env.ORIGIN || 'https://' + config.rpId;
  config.baseUrl = config.baseUrl === 'https://uneditable.app.workbuddy.host'
    ? config.origin : config.baseUrl;
}
if (process.env.CONTRACT_ADDRESS) config.contractAddress = process.env.CONTRACT_ADDRESS;

export const PORT = Number(process.env.PORT || 3000);
export const CHAIN_ID = config.chainId;
export const EXPLORER = config.explorer;
export const FAUCET_URL = 'https://faucet.monad.xyz/';

export const webAuthnParams = (rpId, origin) => {
  const r = rpId || config.rpId;
  const o = origin || config.origin;
  return {
    rpId: r,
    origin: o,
    rpIdHash: sha256(toBytes(r)),
    originNeedleHex: toHex(new TextEncoder().encode('"origin":"' + o + '"'))
  };
};
