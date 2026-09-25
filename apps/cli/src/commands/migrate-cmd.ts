
import chalk from 'chalk';
import * as path from 'path';

import {
  discoverExternalMcpServers,
  toMcpServerConfig,
  discoverExternalSessions,
  discoverExternalProviders,
  importExternalSession,
  type ExternalMcpCandidate,
  type MigrationSource,
} from '@neoxlabs/core/migrate/index.js';
import { listMcpServers, addMcpServer } from '@neoxlabs/core/mcp/index.js';
import { skillRegistry } from '@neoxlabs/core/skills/index.js';
import { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';

function human(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(0) + ' KB';
  return bytes + ' B';
}

function printHelp(): void {
  console.log('Usage: neox migrate [--apply] [--skills-only|--mcp-only|--sessions-only|--providers-only]');
  console.log('');
  console.log('  从 Claude Code / Codex / Cursor 搬运技能、MCP、历史会话、API Key。');
  console.log('  默认只扫描并打印清单 (不改任何文件); 加 --apply 才真正导入。');
  console.log('');
  console.log('  --apply            真正落盘');
  console.log('  --with-env         连同 MCP 的 env 一起搬 (默认**不搬** — 那里面常有密钥)');
  console.log('  --sessions=N       会话最多列/导 N 个 (默认 8)');
  console.log('  --skills-only      只处理技能');
  console.log('  --mcp-only         只处理 MCP');
  console.log('  --sessions-only    只处理历史会话');
  console.log('  --providers-only   只处理 API Key');
}

export async function handleMigrateCommand(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    printHelp();
    return 0;
  }

  const apply = argv.includes('--apply');
  const withEnv = argv.includes('--with-env');
  const skillsOnly = argv.includes('--skills-only');
  const mcpOnly = argv.includes('--mcp-only');
  const sessionsOnly = argv.includes('--sessions-only');
  const providersOnly = argv.includes('--providers-only');
  const anyOnly = skillsOnly || mcpOnly || sessionsOnly || providersOnly;
  const doSkills = !anyOnly || skillsOnly;
  const doMcp = !anyOnly || mcpOnly;
  const doSessions = !anyOnly || sessionsOnly;
  const doProviders = !anyOnly || providersOnly;
  /* 会话可能上千条 —— 打印和导入都按这个上限走, "打印了什么就搬什么" */
  const sessionLimit = (() => {
    const arg = argv.find((a) => a.startsWith('--sessions='));
    const n = arg ? Number(arg.slice('--sessions='.length)) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 8;
  })();
  const workDir = path.resolve(process.cwd());

  console.log('');
  console.log(chalk.bold('Neox 迁移扫描'));
  console.log(chalk.dim(apply ? '  模式: 落盘 (--apply)' : '  模式: 只扫描 —— 加 --apply 才会写入'));
  console.log('');

  let imported = 0;
  let failed = 0;

  /* ── 技能 ───────────────────────────────────────────── */
  if (doSkills) {
    let candidates: ReturnType<typeof skillRegistry.discoverExternalSkills> = [];
    try {
      candidates = skillRegistry.discoverExternalSkills(workDir);
    } catch (err: any) {
      console.log(chalk.red(`  技能扫描失败: ${err?.message ?? err}`));
    }
    const fresh = candidates.filter((c) => !c.alreadyImported);
    console.log(chalk.bold(`技能  ${candidates.length} 个可见 · ${fresh.length} 个还没导入`));
    const SHOW = 8;
    for (const c of candidates.slice(0, SHOW)) {
      const mark = c.alreadyImported ? chalk.dim('已有') : chalk.green('可导入');
      console.log(`  ${mark}  ${c.id.padEnd(28)} ${chalk.dim(c.source)}`);
    }
    if (candidates.length > SHOW) {
      console.log(chalk.dim(`  … 另有 ${candidates.length - SHOW} 个 (--apply 会全部导入)`));
    }

    if (apply) {
      for (const c of fresh) {
        try {
          const r = await skillRegistry.importFromPath(c.path, 'user');
          if (r.success) { imported++; } else { failed++; console.log(chalk.red(`  ✗ ${c.id}: ${r.error}`)); }
        } catch (err: any) {
          failed++;
          console.log(chalk.red(`  ✗ ${c.id}: ${err?.message ?? err}`));
        }
      }
    }
    console.log('');
  }

  /* ── MCP ────────────────────────────────────────────── */
  if (doMcp) {
    let existing: string[] = [];
    try { existing = listMcpServers(workDir).map((s: { id: string }) => s.id); } catch { /* 配置读不了就当空 */ }

    let mcp: ExternalMcpCandidate[] = [];
    try { mcp = discoverExternalMcpServers(existing); } catch (err: any) {
      console.log(chalk.red(`  MCP 扫描失败: ${err?.message ?? err}`));
    }
    const freshMcp = mcp.filter((c) => !c.alreadyImported);
    console.log(chalk.bold(`MCP   ${mcp.length} 个可见 · ${freshMcp.length} 个还没导入`));
    for (const c of mcp) {
      const mark = c.alreadyImported ? chalk.dim('已有') : chalk.green('可导入');
      const what = c.transport !== 'stdio' ? c.url : `${c.command ?? ''} ${(c.args ?? []).join(' ')}`.trim();
      const flags = [
        c.disabledAtSource ? chalk.yellow('源里已停用') : '',
        c.envKeys.length ? chalk.yellow(`带 ${c.envKeys.length} 个 env`) : '',
        c.sourceProject ? chalk.dim(`项目 ${path.basename(c.sourceProject)}`) : '',
      ].filter(Boolean).join(' ');
      console.log(`  ${mark}  ${c.id.padEnd(28)} ${chalk.dim(c.source.padEnd(14))} ${String(what).slice(0, 46)} ${flags}`);
    }

    const strippedEnv: string[] = [];
    if (apply) {
      for (const c of freshMcp) {
        try {
          const cfg = toMcpServerConfig(c);
          if (cfg.env && !withEnv) {
            strippedEnv.push(`${c.id} (${c.envKeys.length} 个)`);
            delete cfg.env;
          }
          addMcpServer(workDir, 'user', cfg);
          imported++;
        } catch (err: any) {
          failed++;
          console.log(chalk.red(`  ✗ ${c.id}: ${err?.message ?? err}`));
        }
      }
      if (strippedEnv.length) {
        console.log(chalk.yellow(`  ⚠ 已跳过这些 server 的 env: ${strippedEnv.join(', ')}`));
        console.log(chalk.yellow('    它们可能带密钥。确认要一起搬就加 --with-env, 或事后用 `neox mcp add` 单独补。'));
      }
    }
    console.log('');
  }

  /* ── 项目指令 ────────────────────────────────────────── */
  console.log(chalk.bold('项目指令'));
  console.log(chalk.dim('  CLAUDE.md / AGENTS.md / .cursorrules 无需搬运 —— Neox 运行时已经直接认这几个文件'));
  console.log(chalk.dim('  (分层扫描见 neox-kernel/core/projectInstructions.ts)'));
  console.log('');

  /* ── 会话 ────────────────────────────────────────────── */
  const scan = discoverExternalSessions();
  if (doSessions && scan.sessions.length > 0) {
    const projects = new Set(scan.sessions.map((s: { cwd: string | null }) => s.cwd ?? '(未知)'));
    console.log(chalk.bold(`历史会话  ${scan.sessions.length} 个 · ${projects.size} 个项目 · ${human(scan.totalBytes)}`));
    for (const s of scan.sessions.slice(0, sessionLimit)) {
      console.log(`  ${chalk.dim(s.updatedAt.slice(0, 16).replace('T', ' '))}  ${chalk.dim(s.source === 'codex' ? 'codex ' : 'claude')}  ${String(s.cwd ?? '(未知)').slice(-34).padEnd(36)} ${human(s.bytes).padStart(9)}  ${chalk.dim((s.title ?? '').slice(0, 26))}`);
    }
    if (scan.sessions.length > sessionLimit) console.log(chalk.dim(`  … 另有 ${scan.sessions.length - sessionLimit} 个 (用 --sessions=N 调整)`));

    if (apply) {
      /* 只搬列出来的那些 —— CLI 里没有勾选界面, "打印了什么就搬什么"是唯一
       * 不会让人意外的口径。要更多就 --sessions=N。 */
      let ok = 0; let dup = 0;
      for (const s of scan.sessions.slice(0, sessionLimit)) {
        try {
          const r = await importExternalSession(s.filePath, s.source as MigrationSource);
          if (r.duplicate) dup++; else { ok++; imported++; }
        } catch (err: any) {
          failed++;
          console.log(chalk.red(`  ✗ ${s.sessionId}: ${err?.message ?? err}`));
        }
      }
      console.log(chalk.green(`  ✓ 导入 ${ok} 个会话${dup ? chalk.dim(` · 跳过 ${dup} 个已导过的`) : ''}`));
      console.log(chalk.dim('    只带对话正文 —— 图片、附件、加密的思考块不搬 (搬过来也解不开)。'));
    } else {
      console.log(chalk.dim(`  --apply 会导入上面这 ${Math.min(sessionLimit, scan.sessions.length)} 个 (用 --sessions=N 调整数量)`));
    }
  }
  console.log('');

  /* ── BYOK ────────────────────────────────────────────── */
  if (doProviders) {
    /* 已有的传进去标 alreadyImported —— 不传的话本机那个早就配好的 deepseek
     * 也会显示成"可导入", 用户会以为我们要覆盖他的配置 */
    let existing: Array<{ id: string; baseUrl?: string }> = [];
    try {
      existing = new ProviderStore().getProviders().map((p) => ({ id: p.id, baseUrl: p.baseUrl }));
    } catch { /* 读不到当空 */ }
    const provs = discoverExternalProviders({ existing, includeSecrets: apply });
    if (provs.length > 0) {
      console.log(chalk.bold(`API Key  ${provs.length} 个供应商配置`));
      for (const p of provs) {
        const mark = p.alreadyImported ? chalk.dim('=') : (p.hasKey ? chalk.green('✓') : chalk.yellow('·'));
        const key = p.hasKey ? chalk.dim(p.keyPreview ?? '') : chalk.yellow(`缺 Key${p.keyEnvName ? ` (${p.keyEnvName})` : ''}`);
        console.log(`  ${mark} ${p.id.padEnd(22)} ${chalk.dim(p.source.padEnd(12))} ${String(p.baseUrl ?? '').padEnd(42)} ${key}`);
      }
      if (apply) {
        const store = new ProviderStore();
        let ok = 0;
        for (const p of provs) {
          if (p.alreadyImported || !p.apiKey) continue;
          try {
            store.addProvider({
              id: p.id, name: p.name, protocol: p.protocol as any, apiKey: p.apiKey,
              baseUrl: p.baseUrl, urlSuffix: p.urlSuffix, defaultModel: p.defaultModel,
            });
            ok++; imported++;
          } catch (err: any) {
            failed++;
            console.log(chalk.red(`  ✗ ${p.id}: ${err?.message ?? err}`));
          }
        }
        console.log(chalk.green(`  ✓ 导入 ${ok} 个供应商`));
        const missing = provs.filter((p) => !p.hasKey && !p.alreadyImported);
        if (missing.length) {
          console.log(chalk.yellow(`  ⚠ ${missing.length} 个读不到 Key —— 它们把 Key 放在环境变量里, 端点已经对了, 去设置里补一个 Key 即可。`));
        }
      } else {
        console.log(chalk.dim('  --apply 会把有 Key 的那些导入 (Key 明文只在本进程内流转, 落盘前加密)'));
      }
      console.log('');
    }
  }

  if (apply) {
    console.log(chalk.bold(`完成: 导入 ${imported} 项${failed ? chalk.red(` · 失败 ${failed} 项`) : ''}`));
    return failed > 0 ? 1 : 0;
  }
  console.log(chalk.dim('这是一次扫描。确认无误后跑 `neox migrate --apply` 落盘。'));
  return 0;
}
