/**
 * report-quality — 任务本身极简 (数行数), 考的是收尾汇报:
 *   事实对 (最长 = beta.js, 总行数 = 97) + 结论明确 + 不啰嗦 (≤5 句话).
 *   三个文件行数确定性生成: alpha 30 / beta 55 / gamma 12, 每行都以 \n 结尾
 *   (wc -l 与逐行读一致, 不留计数歧义).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initGitRepo } from '../../harness.js';

function genJsFile(name: string, lines: number): string {
  const out: string[] = [];
  out.push(`'use strict';`);
  out.push(`// ${name} — 自动生成的演示模块`);
  let i = out.length;
  let fn = 0;
  while (i < lines - 1) {
    const remaining = lines - 1 - i;
    if (remaining >= 3) {
      out.push(`function ${name}_op${fn}(x) {`);
      out.push(`  return x + ${fn};`);
      out.push(`}`);
      i += 3;
      fn++;
    } else {
      out.push(`// padding ${i}`);
      i++;
    }
  }
  out.push(`module.exports = {};`);
  if (out.length !== lines) throw new Error(`genJsFile(${name}): ${out.length} != ${lines}`);
  return out.join('\n') + '\n';
}

export async function setup(workDir: string): Promise<void> {
  mkdirSync(join(workDir, 'src'), { recursive: true });
  writeFileSync(join(workDir, 'src', 'alpha.js'), genJsFile('alpha', 30));
  writeFileSync(join(workDir, 'src', 'beta.js'), genJsFile('beta', 55));
  writeFileSync(join(workDir, 'src', 'gamma.js'), genJsFile('gamma', 12));
  await initGitRepo(workDir);
}
