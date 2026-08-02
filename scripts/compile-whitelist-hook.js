import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileWhitelistHook } from '../whitelist-hook-deployment.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourcePath = path.join(root, 'contracts', 'WhitelistLiquidityHook.sol');
const source = await fs.readFile(sourcePath, 'utf8');
const artifact = compileWhitelistHook(source);

console.log(JSON.stringify({
  compiler: 'solc 0.8.26',
  contract: 'WhitelistLiquidityHook',
  creationBytecodeBytes: (artifact.bytecode.length - 2) / 2,
  runtimeBytecodeBytes: (artifact.deployedBytecode.length - 2) / 2,
  warnings: artifact.warnings
}, null, 2));

