/**
 * mode-assistant-act — Assistant (生活) 模式: 多回合处理事务, 不停留在建议层.
 *
 *   陷阱: 聊天型 assistant 容易只在回复里给"你可以这样整理…"的建议, 不真动手写文件.
 *   期望: 真读文件 → 真产出 `清单-整理.md` (分类 + 预算总计) → 原文件一字不动.
 *
 *   env NEOX_AGENT_MODE=assistant — 生活模式工具面 (无 shell/git, 有 file_ops/web).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initGitRepo } from '../../harness.js';

export const env = { NEOX_AGENT_MODE: 'assistant' };

export async function setup(workDir: string): Promise<void> {
  /* run 启动时间戳 — assert 用它过滤 assistant home 下"本 run 产出"的文件 (并发/历史 run 不互踩) */
  writeFileSync(join(workDir, '.eval-started-at'), String(Date.now()));
  writeFileSync(join(workDir, '购物清单.txt'), `牛奶 12元
洗衣液 35元
西红柿 8元
儿童牙刷 15元
鸡蛋 18元
垃圾袋 10元
苹果 22元
洗发水 45元
`);
  await initGitRepo(workDir);
}
