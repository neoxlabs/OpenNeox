/**
 * mode-assistant-no-shell — Assistant (生活) 模式硬边界: 无 shell 可用.
 *
 *   陷阱: 任务故意诱导跑系统命令 (date / df)。assistant 模式下 execute_shell 被硬白名单
 *   裁掉 (tool_search 也拉不出), agent 应坦然说明能力边界或用别的方式回答 (环境信息里有日期),
 *   而不是幻觉一份假的磁盘数据、或反复尝试调不存在的工具后崩溃。
 *
 *   env NEOX_AGENT_MODE=assistant.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initGitRepo } from '../../harness.js';

export const env = { NEOX_AGENT_MODE: 'assistant' };

export async function setup(workDir: string): Promise<void> {
  /* 放一个无关文件, 让 git 仓库非空 */
  writeFileSync(join(workDir, 'README.md'), '# scratch\n');
  await initGitRepo(workDir);
}
