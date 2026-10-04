import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { NEOX_HOME_DIRNAME } from '../neoxHome.js';

/** 仓库根 —— 这个文件在 packages/kernel/src/platform/__tests__/ 下 */
const REPO = path.resolve(__dirname, '../../../../..');

/** 构建产物路径 —— 扫源码的闸一律跳过 */
const BUILD_OUTPUT = /\/dist\/|\/src-tauri\/target\/|\/src-tauri\/resources\/node_modules\//;

function grep(pattern: string): string[] {
  try {
    const out = execFileSync('grep', ['-rn', '--include=*.ts', '--include=*.tsx',
      '--include=*.cjs', '--include=*.mts', pattern, 'packages'],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return out.split('\n').filter(Boolean).filter((l) => !BUILD_OUTPUT.test(l));
  } catch { return []; }   /* grep 无命中 → 退出码 1 */
}

const HOMEISH = /homedir\(\)|os\.homedir|[A-Za-z_$][A-Za-z0-9_$]*[Hh]ome[A-Za-z0-9_$]*\s*,|\(\s*HOME\s*,/;

/** 引不到 kernel 常量、只能写字面量的三处 —— 每一处源码里都写了原因 */
const LITERAL_EXCEPTIONS = [
  'apps/desktop/src/ui/electron/preload.cjs',   // CJS + 受限上下文
  'packages/oauth/src/token-store.ts',              // 该包不依赖 kernel
  'packages/sandbox/src/policy.ts',                 // 同上
  /* 发给用户的独立 cjs 模板 —— 它们跑在装机脚本里, 没有 node_modules 可引。
   * uninstall 尤其要紧: 值错了会去删**标准版**的 auth.enc, 把另一个产品登出。 */
  'apps/cli/publish-templates/main/uninstall.cjs',
  'apps/cli/publish-templates/main/cli-wrapper.cjs',
  'packages/platform/src/platform/database.ts',
  'packages/platform/src/platform/liteHomeMerge.ts',
];

describe('极简版用户目录隔离', () => {
  it('自检: 扫描确实能命中东西 (否则下面全是空集平凡通过)', () => {
    /* 对照组 —— 路径/grep 写错时这条先红。空集上断言"没有违规"永远成立。 */
    expect(grep("NEOX_HOME_DIRNAME").length).toBeGreaterThan(50);
  });

  it('常量是两个发行版目录名之一 (不是随手写的别的值)', () => {
    expect(['.neox', '.neox-lite']).toContain(NEOX_HOME_DIRNAME);
  });

  it('没有任何 home 系路径还写死 .neox', () => {
    const offenders = grep("'\\.neox'")
      .filter((l) => HOMEISH.test(l))
      .filter((l) => !l.includes('neoxHome.ts'))          /* 那是说明文字 */
      .filter((l) => !/__tests__\/neoxHomeSingleSource/.test(l))   /* 闸排掉自己的源码 */
      .filter((l) => !/__tests__\/codeExecConfigGuard/.test(l))    /* 见下面那条用例的说明 */
      .filter((l) => !LITERAL_EXCEPTIONS.some((f) => l.startsWith(f + ':')));
    expect(offenders, `这些 home 系路径漏了隔离:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('拼在斜杠路径里的 .neox/ 也得备案 (独立字面量那条 grep 抓不到)', () => {
    /* 备案 = 「文件 + 该行的原文」。用整行原文而不是行号 —— 行号会因为无关改动漂移,
     * 备案就会变成"每次改文件都要来更新一次"的噪音。 */
    const WORKSPACE_PATH_OK: Array<[file: string, code: string]> = [
      /* ── 工作区系: 跟 .git 同级的项目本地元数据, 各发行版共用是对的 ── */
      ['packages/kernel/src/core/projectInstructions.ts', "'.neox/INSTRUCTIONS.md',"],
      ['packages/core/src/runtime/projectMemory.ts', "'.neox/project.md',"],
      ['packages/core/src/tools/smart-read/types.ts', "cacheDir: '.neox/index',"],
      ['packages/core/src/runtime/services/serviceConfigStore.ts', "const FILE_REL = '.neox/run-configs.json';"],
      /* 界面文案 / 评测里的路径判断, 说的都是工作区那份 */
      ['apps/cli/src/ui/skillsAndLanguageMenus.ts', "{ label: tr.skillsMenu.workspaceLocal, value: 'workspace', description: '.neox/skills/' },"],
      ['packages/evals/src/agent-ide-bench/workspace.ts', "if (file.startsWith('.neox/')) continue;"],
      ['packages/evals/src/agent-ide-bench/grader.ts', "if (m && !m[3].startsWith('.neox/')) loc += parseInt(m[1], 10) + parseInt(m[2], 10);"],
      /* 测试里断言的是工作区那份 */
      ['packages/core/src/memory/__tests__/simpleLivingMemory.test.ts', "projectSource: '.neox/project.md',"],
      ['packages/core/src/runtime/__tests__/projectInstructionsInjection.test.ts', "it('.neox/INSTRUCTIONS.md takes precedence over NEOX.md', async () => {"],
      ['packages/core/src/knowledge/__tests__/knowledge.test.ts', "expect(card.displayPath).toBe('.neox/knowledge/sheet/univer.md');"],
      ['packages/core/src/knowledge/__tests__/knowledge.test.ts', "expect(loadCardFile(path.join(tmpDir, '.neox/knowledge/policy.md'), path.join(tmpDir, '.neox/knowledge'), 'workspace', tmpDir)!.meta.always).toBe(true);"],
      /* 这条测的正是"往上找记忆时必须在 home 前停住" —— 它在临时目录里造一个假的
       * `~/.neox/project.md` 来验证**不会**被当成项目记忆。路径是造数据, 不是产品路径。 */
      ['packages/core/src/memory/__tests__/memoryRootAndCap.test.ts', "touch('.neox/project.md', '这是用户目录, 不该被当成项目记忆');"],
      /* 自定义 agent 角色也住在**工作区**那份 .neox/ 里 (跟 skills / knowledge 同一层),
       * 这条断言的是"模型用不了时报错要指到具体哪个角色文件"。 */
      ['packages/core/src/runtime/agent/__tests__/agentModelCatalog.test.ts', "expect(out, '要指到具体哪个文件, 否则用户不知道去哪改').toContain('.neox/agents/auditor.md');"],
      /* 风险评估的输入参数: 模型要写的目标路径是造数据, 验的是"写用户技能目录算不算高危" */
      ['packages/core/src/core/__tests__/toolRiskEvaluator.test.ts', "args: { file_path: path.join(os.homedir(), '.neox/skills/demo/SKILL.md'), content: 'x' },"],
      /* ── 不是磁盘路径: 备份 zip **包内**的条目前缀, 真实路径取自已隔离的 neoxHome 变量 ── */
      ['apps/desktop/src/ui/electron/ipc/backupHandlers.ts', "'.neox/': neoxHome,"],
    ];
    const offenders = grep("'\\.neox/")
      .filter((l) => !l.includes('neoxHome.ts'))
      .filter((l) => !/__tests__\/neoxHomeSingleSource/.test(l))
      /* 路径守卫那份测试**整份豁免**: 它每一行断言都是拿 `.neox/…` 当**造数据**,
       * 验的正是"哪些 .neox 路径该拦、哪些不该"。逐条备案会是几十行噪音, 而且它每加
       * 一个用例就要回来改一次这里 —— 备案表就是这么烂掉的。 */
      .filter((l) => !/__tests__\/codeExecConfigGuard/.test(l))
      /* 敏感路径判定的测试同理: 整份都是拿 `.neox/…` 造数据, 验哪些该拦、哪些放行 */
      .filter((l) => !/__tests__\/sensitivePaths\.test/.test(l))
      /* 排掉注释行 —— 仓库里的注释写满了路径举例, 那些不是代码。
       * (判据是"该行代码部分以注释符起头", 不是"整行含注释符"。) */
      .filter((l) => {
        const code = l.split(':').slice(2).join(':').trim();
        return !(code.startsWith('*') || code.startsWith('//') || code.startsWith('/*'));
      })
      .filter((l) => {
        const [file, , ...rest] = l.split(':');
        const code = rest.join(':').trim();
        return !WORKSPACE_PATH_OK.some(([f, c]) => file === f && code === c);
      });
    expect(offenders, `这些 .neox/ 路径没备案:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('写死另一个发行版目录名的, 只有有据可查的那几处', () => {
    const files = new Set(
      grep("'\\.neox-lite'")
        .filter((l) => !/__tests__/.test(l))
        .map((l) => l.split(':')[0]),
    );
    files.delete('packages/kernel/src/platform/neoxHome.ts');
    for (const f of files) {
      expect(LITERAL_EXCEPTIONS, `${f} 写死了 .neox-lite 但没备案`).toContain(f);
    }
  });
});
