
import chalk from 'chalk';
import * as path from 'path';

import {
  discoverExternalMcpServers,
  toMcpServerConfig,
  discoverExternalSessions,
  discoverExternalProviders,
  importExternalSession,
  discoverExternalMemories,
  importExternalMemories,
  type ExternalMcpCandidate,
  type ExternalMemoryCandidate,
  type MigrationSource,
} from '@neoxlabs/core/migrate/index.js';
import { ActionLogService } from '@neoxlabs/core/platform/actionLog/index.js';
import { listMcpServers, addMcpServer } from '@neoxlabs/core/mcp/index.js';
import { skillRegistry } from '@neoxlabs/core/skills/index.js';
import { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import { L } from '../i18n/index.js';

function human(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(0) + ' KB';
  return bytes + ' B';
}

function printHelp(): void {
  console.log('Usage: neox migrate [--apply] [--skills-only|--mcp-only|--memories-only|--sessions-only|--providers-only]');
  console.log('');
  console.log(L('  从 Claude Code / Codex / Cursor / Hermes 搬运技能、MCP、记忆、历史会话、API Key。',
    '  Brings skills, MCP servers, memory, past sessions and API keys over from Claude Code / Codex / Cursor / Hermes.'));
  console.log(L('  记忆落到当前目录这个项目里, 在要搬的项目目录下跑。', '  Memory lands in the project in the current directory — run it from that project.'));
  console.log(L('  默认只扫描并打印清单 (不改任何文件); 加 --apply 才真正导入。', '  By default it only scans and lists (changes nothing); add --apply to import.'));
  console.log('');
  console.log(L('  --apply            真正落盘', '  --apply            actually write'));
  console.log(L('  --link             技能用软链导入 (源目录改了这边跟着变); 默认复制一份', '  --link             symlink skills (follows the source); copies by default'));
  console.log(L('  --with-env         连同 MCP 的 env 一起搬 (默认**不搬** — 那里面常有密钥)', '  --with-env         bring MCP env too (off by default — it often holds secrets)'));
  console.log(L('  --sessions=N       会话最多列/导 N 个 (默认 8)', '  --sessions=N       list/import up to N sessions (default 8)'));
  console.log(L('  --skills-only      只处理技能', '  --skills-only      skills only'));
  console.log(L('  --mcp-only         只处理 MCP', '  --mcp-only         MCP only'));
  console.log(L('  --memories-only    只处理记忆', '  --memories-only    memory only'));
  console.log(L('  --sessions-only    只处理历史会话', '  --sessions-only    past sessions only'));
  console.log(L('  --providers-only   只处理 API Key', '  --providers-only   API keys only'));
}

export async function handleMigrateCommand(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    printHelp();
    return 0;
  }

  const apply = argv.includes('--apply');
  const withEnv = argv.includes('--with-env');
  const linkSkills = argv.includes('--link');
  const skillsOnly = argv.includes('--skills-only');
  const mcpOnly = argv.includes('--mcp-only');
  const sessionsOnly = argv.includes('--sessions-only');
  const providersOnly = argv.includes('--providers-only');
  const memoriesOnly = argv.includes('--memories-only');
  const anyOnly = skillsOnly || mcpOnly || sessionsOnly || providersOnly || memoriesOnly;
  const doMemories = !anyOnly || memoriesOnly;
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
  const existed = () => chalk.dim(L('已有', 'have'));
  const importable = () => chalk.green(L('可导入', 'new '));
  console.log(chalk.bold(L('Neox 迁移扫描', 'Neox migration scan')));
  console.log(chalk.dim(apply ? L('  模式: 落盘 (--apply)', '  Mode: writing (--apply)') : L('  模式: 只扫描 —— 加 --apply 才会写入', '  Mode: scan only — add --apply to write')));
  console.log('');

  let imported = 0;
  let failed = 0;

  /* ── 技能 ───────────────────────────────────────────── */
  if (doSkills) {
    let candidates: ReturnType<typeof skillRegistry.discoverExternalSkills> = [];
    try {
      candidates = skillRegistry.discoverExternalSkills(workDir);
    } catch (err: any) {
      console.log(chalk.red(`  ${L('技能扫描失败', 'Skill scan failed')}: ${err?.message ?? err}`));
    }
    const fresh = candidates.filter((c) => !c.alreadyImported);
    console.log(chalk.bold(L(`技能  ${candidates.length} 个可见 · ${fresh.length} 个还没导入`, `Skills  ${candidates.length} found · ${fresh.length} not imported yet`)));
    const SHOW = 8;
    for (const c of candidates.slice(0, SHOW)) {
      const mark = c.alreadyImported ? existed() : importable();
      console.log(`  ${mark}  ${c.id.padEnd(28)} ${chalk.dim(c.source)}`);
    }
    if (candidates.length > SHOW) {
      console.log(chalk.dim(L(`  … 另有 ${candidates.length - SHOW} 个 (--apply 会全部导入)`, `  … ${candidates.length - SHOW} more (--apply imports all)`)));
    }

    if (apply) {
      for (const c of fresh) {
        try {
          const r = await skillRegistry.importFromPath(c.path, 'user', undefined, linkSkills ? 'link' : 'copy');
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
      console.log(chalk.red(`  ${L('MCP 扫描失败', 'MCP scan failed')}: ${err?.message ?? err}`));
    }
    const freshMcp = mcp.filter((c) => !c.alreadyImported);
    console.log(chalk.bold(L(`MCP   ${mcp.length} 个可见 · ${freshMcp.length} 个还没导入`, `MCP   ${mcp.length} found · ${freshMcp.length} not imported yet`)));
    for (const c of mcp) {
      const mark = c.alreadyImported ? existed() : importable();
      const what = c.transport !== 'stdio' ? c.url : `${c.command ?? ''} ${(c.args ?? []).join(' ')}`.trim();
      const flags = [
        c.disabledAtSource ? chalk.yellow(L('源里已停用', 'disabled at source')) : '',
        c.envKeys.length ? chalk.yellow(L(`带 ${c.envKeys.length} 个 env`, `${c.envKeys.length} env vars`)) : '',
        c.sourceProject ? chalk.dim(`${L('项目', 'project')} ${path.basename(c.sourceProject)}`) : '',
      ].filter(Boolean).join(' ');
      console.log(`  ${mark}  ${c.id.padEnd(28)} ${chalk.dim(c.source.padEnd(14))} ${String(what).slice(0, 46)} ${flags}`);
    }

    const strippedEnv: string[] = [];
    if (apply) {
      for (const c of freshMcp) {
        try {
          const cfg = toMcpServerConfig(c);
          if (cfg.env && !withEnv) {
            strippedEnv.push(`${c.id} (${c.envKeys.length})`);
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
        console.log(chalk.yellow(`  ⚠ ${L('已跳过这些 server 的 env', 'Skipped env for')}: ${strippedEnv.join(', ')}`));
        console.log(chalk.yellow(L('    它们可能带密钥。确认要一起搬就加 --with-env, 或事后用 `neox mcp add` 单独补。',
          '    They may hold secrets. Add --with-env to bring them, or add them later with `neox mcp add`.')));
      }
    }
    console.log('');
  }

  if (doMemories) {
    const actionLog = new ActionLogService({ source: 'cli', agentName: 'Neox CLI' });
    let mems: ExternalMemoryCandidate[] = [];
    try {
      await actionLog.setWorkspace(workDir);
      const existing = await actionLog.getMemoryEntries({ type: 'all', limit: 10_000 });
      mems = discoverExternalMemories({ workDir, existing: existing.map((e) => e.content) });
    } catch (err: any) {
      console.log(chalk.red(`  ${L('记忆扫描失败', 'Memory scan failed')}: ${err?.message ?? err}`));
    }
    const freshMem = mems.filter((m) => !m.alreadyImported);
    console.log(chalk.bold(L(`记忆  ${mems.length} 条可见 · ${freshMem.length} 条还没导入`, `Memory  ${mems.length} found · ${freshMem.length} not imported yet`)) + chalk.dim(`  → ${path.basename(workDir)}`));
    const SHOW = 8;
    for (const m of mems.slice(0, SHOW)) {
      const mark = m.alreadyImported ? existed() : importable();
      const line = (m.title || m.summary).replace(/\s+/g, ' ').slice(0, 40);
      console.log(`  ${mark}  ${line.padEnd(40)} ${chalk.dim(m.source)}`);
    }
    if (mems.length > SHOW) {
      console.log(chalk.dim(L(`  … 另有 ${mems.length - SHOW} 条 (--apply 会全部导入)`, `  … ${mems.length - SHOW} more (--apply imports all)`)));
    }
    if (apply && freshMem.length > 0) {
      imported += importExternalMemories(actionLog, freshMem);
      await actionLog.flush();
    }
    console.log('');
  }

  /* ── 项目指令 ────────────────────────────────────────── */
  console.log(chalk.bold(L('项目指令', 'Project instructions')));
  console.log(chalk.dim(L('  CLAUDE.md / AGENTS.md / .cursorrules 无需搬运 —— Neox 运行时已经直接认这几个文件',
    '  CLAUDE.md / AGENTS.md / .cursorrules need no migration — Neox reads them directly')));
  console.log('');

  /* ── 会话 ────────────────────────────────────────────── */
  const scan = discoverExternalSessions();
  if (doSessions && scan.sessions.length > 0) {
    const unknown = L('(未知)', '(unknown)');
    const projects = new Set(scan.sessions.map((s: { cwd: string | null }) => s.cwd ?? unknown));
    console.log(chalk.bold(L(`历史会话  ${scan.sessions.length} 个 · ${projects.size} 个项目 · ${human(scan.totalBytes)}`, `Past sessions  ${scan.sessions.length} · ${projects.size} projects · ${human(scan.totalBytes)}`)));
    for (const s of scan.sessions.slice(0, sessionLimit)) {
      console.log(`  ${chalk.dim(s.updatedAt.slice(0, 16).replace('T', ' '))}  ${chalk.dim(s.source === 'codex' ? 'codex ' : 'claude')}  ${String(s.cwd ?? unknown).slice(-34).padEnd(36)} ${human(s.bytes).padStart(9)}  ${chalk.dim((s.title ?? '').slice(0, 26))}`);
    }
    if (scan.sessions.length > sessionLimit) console.log(chalk.dim(L(`  … 另有 ${scan.sessions.length - sessionLimit} 个 (用 --sessions=N 调整)`, `  … ${scan.sessions.length - sessionLimit} more (change with --sessions=N)`)));

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
      console.log(chalk.green(L(`  ✓ 导入 ${ok} 个会话`, `  ✓ ${ok} sessions imported`) + (dup ? chalk.dim(L(` · 跳过 ${dup} 个已导过的`, ` · ${dup} already imported`)) : '')));
      console.log(chalk.dim(L('    只带对话正文 —— 图片、附件、加密的思考块不搬 (搬过来也解不开)。',
        '    Text only — images, attachments and encrypted thinking blocks aren’t carried over.')));
    } else {
      const n = Math.min(sessionLimit, scan.sessions.length);
      console.log(chalk.dim(L(`  --apply 会导入上面这 ${n} 个 (用 --sessions=N 调整数量)`, `  --apply imports the ${n} above (change with --sessions=N)`)));
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
      console.log(chalk.bold(L(`API Key  ${provs.length} 个供应商配置`, `API keys  ${provs.length} providers`)));
      for (const p of provs) {
        const mark = p.alreadyImported ? chalk.dim('=') : (p.hasKey ? chalk.green('✓') : chalk.yellow('·'));
        const key = p.hasKey ? chalk.dim(p.keyPreview ?? '') : chalk.yellow(`${L('缺 Key', 'no key')}${p.keyEnvName ? ` (${p.keyEnvName})` : ''}`);
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
        console.log(chalk.green(L(`  ✓ 导入 ${ok} 个供应商`, `  ✓ ${ok} providers imported`)));
        const missing = provs.filter((p) => !p.hasKey && !p.alreadyImported);
        if (missing.length) {
          console.log(chalk.yellow(L(`  ⚠ ${missing.length} 个读不到 Key —— 它们把 Key 放在环境变量里, 端点已经对了, 去设置里补一个 Key 即可。`,
            `  ⚠ ${missing.length} have no readable key — it lives in an env var. The endpoint is set; add the key in settings.`)));
        }
      } else {
        console.log(chalk.dim(L('  --apply 会把有 Key 的那些导入 (Key 明文只在本进程内流转, 落盘前加密)',
          '  --apply imports the ones with keys (keys stay in this process and are encrypted before saving)')));
      }
      console.log('');
    }
  }

  if (apply) {
    console.log(chalk.bold(L(`完成: 导入 ${imported} 项`, `Done: ${imported} imported`) + (failed ? chalk.red(L(` · 失败 ${failed} 项`, ` · ${failed} failed`)) : '')));
    return failed > 0 ? 1 : 0;
  }
  console.log(chalk.dim(L('这是一次扫描。确认无误后跑 `neox migrate --apply` 落盘。', 'This was a scan. Run `neox migrate --apply` to import.')));
  return 0;
}
