
import { ipcMain } from './ipcMainBridged.js';
/* 类型是纯类型导入, 编译后完全擦除 —— 不会在运行时把 electron 拉进来。
 * 值 (ipcMain) 走桥的替身, 于是这个文件在纯 Node 后端里也 import 得动。 */
import type { IpcMainInvokeEvent } from 'electron';
import * as path from 'path';

import {
  discoverExternalMcpServers,
  toMcpServerConfig,
  discoverExternalSessionsAsync,
  discoverExternalProviders,
  importExternalSession,
  type MigrationSource,
} from '@neoxlabs/core/migrate/index.js';
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { fetchProviderModels } from './providerModelHandlers.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { listMcpServers, addMcpServer } from '@neoxlabs/core/mcp/index.js';
import { SkillRegistry } from '@neoxlabs/core/skills/index.js';
import { SKILL_REGISTRY } from '../context/tokens.js';
import type { ProjectManager } from '../context/ProjectManager.js';

/** 会话可能上千条 (本机 1317 条), 界面一次只铺最近这些, 其余走"全部导入" */
const SESSION_LIST_LIMIT = 200;

interface RegisterMigrateIpcHandlersOptions {
  projectManager: ProjectManager;
}

export interface MigrateScanResult {
  skills: Array<{ id: string; name: string; source: string; path: string; alreadyImported: boolean }>;
  mcp: Array<{
    id: string; source: string; transport: string; summary: string;
    envKeys: string[]; disabledAtSource: boolean; alreadyImported: boolean;
  }>;
  sessions: {
    count: number; projects: number; totalBytes: number;
    /** 按来源分开计数 —— 用户看得出"我 Codex 那 1200 个也在里面" */
    bySource: Record<string, number>;
    /** 最近的一批候选 (全量可能上千条, 界面不需要一次铺完) */
    recent: Array<{ source: string; sessionId: string; filePath: string; cwd: string | null; title: string | null; bytes: number; updatedAt: string; alreadyImported: boolean }>;
  };
  /** 一眼判断"值不值得弹这一屏" —— 全 0 就别打扰用户 */
  freshCount: number;
}

export function registerMigrateIpcHandlers(options: RegisterMigrateIpcHandlersOptions): void {
  const { projectManager } = options;

  /* 跟 skillsHandlers 一样按发起窗口取 scope; 没 scope (welcome / onboarding 页)
   * 时用 cwd 建临时 registry —— **迁移恰恰主要发生在 onboarding**, 这条降级路径
   * 不是边角情况, 是主路径。 */
  function resolve(event: IpcMainInvokeEvent): { registry: SkillRegistry; workDir: string } {
    const scope = projectManager.getBySender(event?.sender as any);
    const workDir = scope?.workspacePath ?? process.cwd();
    const registry = scope?.getService?.(SKILL_REGISTRY) as SkillRegistry | undefined;
    /* 构造函数不收 workDir —— workDir 是逐次调用传给 discover/import 的 (跟 skillsHandlers 一致) */
    return { registry: registry ?? new SkillRegistry(), workDir };
  }

  ipcMain.handle('migrate:scan', async (event): Promise<MigrateScanResult> => {
    const { registry, workDir } = resolve(event);

    let skills: MigrateScanResult['skills'] = [];
    try {
      skills = registry.discoverExternalSkills(workDir).map((s) => ({
        id: s.id, name: s.name, source: s.source, path: s.path, alreadyImported: s.alreadyImported,
      }));
    } catch { /* 一类源坏了不该让整屏空掉 */ }

    let mcp: MigrateScanResult['mcp'] = [];
    try {
      let existing: string[] = [];
      try { existing = listMcpServers(workDir).map((s: { id: string }) => s.id); } catch { /* 配置读不了当空 */ }
      mcp = discoverExternalMcpServers(existing).map((c) => ({
        id: c.id,
        source: c.source,
        transport: c.transport,
        summary: c.transport !== 'stdio'
          ? (c.url ?? '')
          : `${c.command ?? ''} ${(c.args ?? []).join(' ')}`.trim(),
        envKeys: c.envKeys,
        disabledAtSource: c.disabledAtSource,
        alreadyImported: c.alreadyImported,
      }));
    } catch { /* 同上 */ }

    let sessions: MigrateScanResult['sessions'] = { count: 0, projects: 0, totalBytes: 0, bySource: {}, recent: [] };
    try {
      const scan = await discoverExternalSessionsAsync();
      const bySource: Record<string, number> = {};
      for (const s of scan.sessions) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
      /* 库里已经有同 id 的就是导过了 —— 会话 id 沿用源里的 uuid, 所以这一步够了,
       * 不用另建一张"导过哪些"的表 (见 importSessions.ts 头部)。 */
      const db = getDatabase();
      sessions = {
        count: scan.sessions.length,
        projects: new Set(scan.sessions.map((s) => s.cwd ?? '?')).size,
        totalBytes: scan.totalBytes,
        bySource,
        recent: scan.sessions.slice(0, SESSION_LIST_LIMIT).map((s) => ({
          source: s.source,
          sessionId: s.sessionId,
          filePath: s.filePath,
          cwd: s.cwd,
          title: s.title,
          bytes: s.bytes,
          updatedAt: s.updatedAt,
          alreadyImported: (() => { try { return !!db.getSession(s.sessionId); } catch { return false; } })(),
        })),
      };
    } catch { /* 同上 */ }

    /* 会话也算进来 —— 只装过 Claude Code 但没配过 skill/MCP 的用户 (很常见) 以前
     * freshCount=0, 整屏都不会出现, 于是"迁移"对他等于不存在。 */
    const freshCount =
      skills.filter((s) => !s.alreadyImported).length
      + mcp.filter((m) => !m.alreadyImported).length
      + sessions.recent.filter((s) => !s.alreadyImported).length;

    return { skills, mcp, sessions, freshCount };
  });

  ipcMain.handle('migrate:apply', async (
    event,
    payload: {
      skillPaths?: string[]; mcpIds?: string[]; withEnv?: boolean;
      sessions?: Array<{ filePath: string; source: MigrationSource }>;
    },
  ): Promise<{ imported: number; failed: number; envStripped: string[]; errors: string[]; sessionsImported: number; sessionsDuplicate: number }> => {
    const { registry, workDir } = resolve(event);
    const errors: string[] = [];
    const envStripped: string[] = [];
    let imported = 0;
    let failed = 0;

    for (const p of payload?.skillPaths ?? []) {
      try {
        const r = await registry.importFromPath(p, 'user', workDir);
        if (r.success) imported++;
        else { failed++; errors.push(`${path.basename(p)}: ${r.error ?? '导入失败'}`); }
      } catch (err: any) {
        failed++;
        errors.push(`${path.basename(p)}: ${err?.message ?? err}`);
      }
    }

    const wantMcp = new Set(payload?.mcpIds ?? []);
    if (wantMcp.size > 0) {
      let candidates: ReturnType<typeof discoverExternalMcpServers> = [];
      try { candidates = discoverExternalMcpServers([]); } catch { /* 扫不到就没得导 */ }
      for (const c of candidates) {
        if (!wantMcp.has(c.id)) continue;
        try {
          const cfg = toMcpServerConfig(c);
          if (cfg.env && !payload?.withEnv) {
            envStripped.push(`${c.id} (${c.envKeys.length})`);
            delete cfg.env;
          }
          addMcpServer(workDir, 'user', cfg, { replace: true });
          imported++;
        } catch (err: any) {
          failed++;
          errors.push(`${c.id}: ${err?.message ?? err}`);
        }
      }
    }

    /* 会话 —— 逐条流式解析后落 sessions/messages/timeline_entries 三张表。
     * 放在最后: 它是这三类里唯一可能跑几十秒的 (一条几十 MB 的会话), 前面的
     * skills/MCP 先落定, 会话慢一点也不影响用户已经拿到的东西。 */
    let sessionsImported = 0;
    let sessionsDuplicate = 0;
    for (const s of payload?.sessions ?? []) {
      try {
        const r = await importExternalSession(s.filePath, s.source);
        if (r.duplicate) sessionsDuplicate++;
        else { sessionsImported++; imported++; }
      } catch (err: any) {
        failed++;
        errors.push(`${path.basename(s.filePath)}: ${err?.message ?? err}`);
      }
    }
    if (sessionsImported > 0) {
      /* 侧栏不会自己发现库里多了行 —— 不推这一下要等下一次轮询 */
      try {
        const { notifyDesktopSessionsChanged } = await import('../mobile-bridge/index.js');
        notifyDesktopSessionsChanged();
      } catch { /* 推送失败不该让导入算失败 */ }
    }

    return { imported, failed, envStripped, errors, sessionsImported, sessionsDuplicate };
  });

  ipcMain.handle('migrate:scan-mcp', async (event) => {
    const { workDir } = resolve(event);
    let existing: string[] = [];
    try { existing = listMcpServers(workDir).map((s: { id: string }) => s.id); } catch { /* 配置读不了当空 */ }
    return discoverExternalMcpServers(existing).map((c) => ({
      id: c.id,
      name: c.sourceName,
      source: c.source,
      sourcePath: c.sourcePath,
      sourceProject: c.sourceProject ?? null,
      transport: c.transport,
      summary: c.transport !== 'stdio'
        ? (c.url ?? '')
        : `${c.command ?? ''} ${(c.args ?? []).join(' ')}`.trim(),
      /* 只给 key 名, 值 (常是密钥) 不过 IPC */
      envKeys: c.envKeys,
      disabledAtSource: c.disabledAtSource,
      alreadyImported: c.alreadyImported,
    }));
  });

  /**
   * BYOK 检测 —— **只在用户按下「检测」时跑这一次**, 没有任何自动触发路径。
   *
   *   返回的 Key 一律是掩码 (`sk-ab…f12`)。明文永远不过 IPC —— 真正落盘时
   *   由 migrate:import-providers 在主进程里重新扫一遍拿明文, 直接交给
   *   configService.addProvider (它落盘前 wrap 成 enc:v1:)。
   */
  ipcMain.handle('migrate:scan-providers', async () => {
    let existing: Array<{ id: string; baseUrl?: string }> = [];
    try {
      existing = (configService.getProviders() ?? []).map((p: any) => ({ id: p.id, baseUrl: p.baseUrl }));
    } catch { /* 读不到当空, 大不了多标几个"未导入" */ }
    return { providers: discoverExternalProviders({ existing }) };
  });

  ipcMain.handle('migrate:import-providers', async (
    _event,
    payload: { ids?: string[]; keys?: Record<string, string>; setDefault?: boolean },
  ): Promise<{ imported: number; failed: number; skippedNoKey: string[]; errors: string[] }> => {
    const want = new Set(payload?.ids ?? []);
    const errors: string[] = [];
    const skippedNoKey: string[] = [];
    let imported = 0;
    let failed = 0;
    if (want.size === 0) return { imported, failed, skippedNoKey, errors };

    /* 这一趟才带明文 —— 只在主进程内部流转 */
    const candidates = discoverExternalProviders({ includeSecrets: true });
    let first = true;
    for (const c of candidates) {
      if (!want.has(c.id)) continue;
      const key = (payload?.keys?.[c.id] ?? '').trim() || c.apiKey || '';
      if (!key) { skippedNoKey.push(c.id); continue; }
      try {
        let defaultModel = (c.defaultModel ?? '').trim();
        let models: string[] = defaultModel ? [defaultModel] : [];
        if (!defaultModel) {
          const fetched = await fetchProviderModels({
            protocol: c.protocol, baseUrl: c.baseUrl, urlSuffix: c.urlSuffix, apiKey: key,
          }).catch((e: any) => ({ models: [] as string[], error: e?.message }));
          models = fetched.models ?? [];
          defaultModel = models[0] ?? '';
          if (!defaultModel) {
            failed++;
            errors.push(`${c.id}: ${fetched.error
              ? `拉模型清单失败 (${fetched.error})`
              : '这个服务商没返回任何模型'} —— Key 和端点是对的, 到「API 服务商」里手填一个模型名即可导入`);
            continue;
          }
        }
        configService.addProvider({
          id: c.id,
          name: c.name,
          protocol: c.protocol,
          apiKey: key,
          baseUrl: c.baseUrl,
          urlSuffix: c.urlSuffix,
          defaultModel,
          models,
          setAsDefault: !!payload?.setDefault && first,
        } as any);
        imported++;
        first = false;
      } catch (err: any) {
        failed++;
        errors.push(`${c.id}: ${err?.message ?? err}`);
      }
    }
    return { imported, failed, skippedNoKey, errors };
  });
}
