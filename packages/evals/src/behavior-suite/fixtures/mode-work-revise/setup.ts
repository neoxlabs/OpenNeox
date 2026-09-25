/**
 * mode-work-revise — Work (工作) 模式: 给文本默认进改稿, 尊重原意不推翻重写.
 *
 *   陷阱: (1) 只在回复里贴润色结果不写回文件; (2) "润色"变成推翻重写, 关键事实
 *   (产品名 星桥系统 / 交付日期 8月15日 / 验收周期 两周) 被改丢。
 *
 *   env NEOX_AGENT_MODE=work — 工作模式工具面 (无 shell/git 写, 有 file_ops/word/sheet)。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initGitRepo } from '../../harness.js';

export const env = { NEOX_AGENT_MODE: 'work' };

export async function setup(workDir: string): Promise<void> {
  writeFileSync(join(workDir, 'draft.md'), `关于项目进度的说明

就是想跟您说一下，我们这边星桥系统的开发的话呢，目前来说进展是基本上还算是比较顺利的，核心功能这块儿的话已经差不多都做完了大概，然后就是测试的话我们预计是在8月15日之前的话就能够全部交付给您那边，到时候验收的话大概需要两周左右的一个时间周期这样子，您看行吗。
`);
  await initGitRepo(workDir);
}
