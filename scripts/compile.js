import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'contracts/BlitzBoard.sol'), 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'BlitzBoard.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: 'cancun',
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] }
    }
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = output.errors || [];
for (const e of errors.filter((x) => x.severity === 'error')) {
  console.error(e.formattedMessage);
}
if (errors.some((x) => x.severity === 'error')) process.exit(1);
for (const w of errors.filter((x) => x.severity !== 'error')) {
  console.warn('[solc warning]', w.formattedMessage.split('\n')[0]);
}

const c = output.contracts['BlitzBoard.sol'].BlitzBoard;
const artifact = {
  contractName: 'BlitzBoard',
  abi: c.abi,
  bytecode: '0x' + c.evm.bytecode.object,
  deployedBytecode: '0x' + c.evm.deployedBytecode.object,
  compiler: 'solc ' + solc.version()
};
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(root, 'artifacts/BlitzBoard.json'), JSON.stringify(artifact, null, 2));
console.log('compiled OK | solc', solc.version(), '| abi entries', c.abi.length,
  '| bytecode bytes', c.evm.bytecode.object.length / 2);
