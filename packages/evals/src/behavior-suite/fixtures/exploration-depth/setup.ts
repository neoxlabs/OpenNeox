/**
 * exploration-depth — 答案要跨 3 个文件拼出来: orders.js → policy.js → constants.js.
 *
 *   真答案 = BASE_RETRIES(4) + PEAK_EXTRA(3) = 7, 只有读到第三个文件 constants.js
 *   并做加法才能得出. 红鲱鱼: orders.js 注释里挂着"早期版本写死 3 次",
 *   偷懒的 agent 读一层就答 3.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initGitRepo } from '../../harness.js';

export async function setup(workDir: string): Promise<void> {
  mkdirSync(join(workDir, 'src'), { recursive: true });

  writeFileSync(join(workDir, 'src', 'orders.js'), `'use strict';
const { RETRY_POLICY } = require('./policy');

/**
 * 订单超时后的重试处理.
 * 注: 早期版本这里写死重试 3 次, 现在统一走 policy 配置.
 */
async function retryOrder(order, attempt, opts = {}) {
  const maxRetries = opts.maxRetries ?? RETRY_POLICY.maxRetries;
  if (attempt >= maxRetries) {
    return { ok: false, reason: 'max-retries-exceeded' };
  }
  await new Promise((r) => setTimeout(r, RETRY_POLICY.backoffMs * (attempt + 1)));
  return { ok: true, attempt: attempt + 1 };
}

module.exports = { retryOrder };
`);

  writeFileSync(join(workDir, 'src', 'policy.js'), `'use strict';
const { BASE_RETRIES, PEAK_EXTRA } = require('./constants');

/** 全局重试策略 — 峰值时段在基础次数上追加富余量. */
const RETRY_POLICY = {
  maxRetries: BASE_RETRIES + PEAK_EXTRA,
  backoffMs: 250,
};

module.exports = { RETRY_POLICY };
`);

  writeFileSync(join(workDir, 'src', 'constants.js'), `'use strict';

/** 基础重试次数 */
const BASE_RETRIES = 4;

/** 峰值时段追加的重试富余量 */
const PEAK_EXTRA = 3;

module.exports = { BASE_RETRIES, PEAK_EXTRA };
`);

  await initGitRepo(workDir);
}
