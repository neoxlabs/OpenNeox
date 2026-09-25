#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('用法: node scripts/run-without-proxy.mjs <cmd> [args...]');
  process.exit(2);
}

const env = { ...process.env };
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete env[key];
}

/* Windows 上 npm / npx / tsx 都是 .cmd shim, 不走 shell 会 ENOENT。 */
const res = spawnSync(cmd, args, {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

if (res.error) {
  console.error(`[run-without-proxy] ${cmd} 启动失败: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
