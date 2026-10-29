import { ipcMain } from './ipcMainBridged.js';
/* 类型是纯类型导入, 编译后完全擦除 —— 不会在运行时把 electron 拉进来。
 * 值 (ipcMain) 走桥的替身, 于是这个文件在纯 Node 后端里也 import 得动。 */
import type { IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import * as os from 'os';
import { SkillRegistry, readHistory, clearHistory } from '@neoxlabs/core/skills/index.js';
import { skillInstallManager } from '@neoxlabs/core/skills/installManager.js';
import { SKILL_REGISTRY } from '../context/tokens.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

interface RegisterSkillsIpcHandlersOptions {
  projectManager: ProjectManager;
}

export function registerSkillsIpcHandlers(options: RegisterSkillsIpcHandlersOptions): void {
  const { projectManager } = options;

  /**
   * 拿当前发起请求窗口的 SkillRegistry, 并在返回前确保已 refresh.
   * 没 scope 时降级为临时 registry (例如 welcome page 调 skills:list).
   */
  const getRegistry = async (
    event: IpcMainInvokeEvent,
  ): Promise<{ registry: SkillRegistry; workDir: string }> => {
    const scope = projectManager.getBySender(event?.sender as any);
    if (scope) {
      const registry = scope.getService(SKILL_REGISTRY);
      await registry.refresh(scope.workspacePath);
      return { registry, workDir: scope.workspacePath };
    }
    // 没 scope: 临时 registry, 用 cwd
    const workDir = process.cwd();
    const registry = new SkillRegistry();
    await registry.refresh(workDir);
    return { registry, workDir };
  };

  // ── 读操作 ────────────────────────────────────────

  ipcMain.handle('skills:list', async (
    event,
    listOptions?: { scope?: string; category?: string; userInvocable?: boolean },
  ) => {
    try {
      const { registry } = await getRegistry(event);
      const skills = registry.list({
        source: listOptions?.scope as any,
        category: listOptions?.category as any,
        userInvocable: listOptions?.userInvocable,
      });
      return skills.map(s => ({
        id: s.id,
        path: s.path,
        source: s.source,
        metadata: s.metadata,
        content: s.content,
        contentLength: s.contentLength,
      }));
    } catch (err) {
      console.error('[skills:list] Failed to list skills:', err);
      return [];
    }
  });

  ipcMain.handle('skills:get', async (event, skillId: string) => {
    try {
      const { registry } = await getRegistry(event);
      const skill = registry.find(skillId);
      if (!skill) return null;
      return {
        id: skill.id,
        path: skill.path,
        source: skill.source,
        metadata: skill.metadata,
        content: skill.content,
        contentLength: skill.contentLength,
      };
    } catch {
      return null;
    }
  });

  ipcMain.handle('skills:refresh', async (event) => {
    try {
      // 强制 refresh —— scope 上的 registry 直接用即可
      await getRegistry(event);
    } catch { /* ignore */ }
  });

  // ── 写操作 ────────────────────────────────────────

  ipcMain.handle('skills:create', async (event, options: {
    id: string;
    name: string;
    description: string;
    category?: string;
    target: 'user' | 'workspace';
    instructions?: string;
  }) => {
    try {
      const { registry, workDir } = await getRegistry(event);
      return await registry.createSkill({ ...options, workDir });
    } catch {
      return null;
    }
  });

  ipcMain.handle('skills:read-raw', async (event, skillId: string) => {
    try {
      const { registry } = await getRegistry(event);
      return registry.readSkillRaw(skillId);
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('skills:write-content', async (event, skillId: string, content: string) => {
    try {
      const { registry, workDir } = await getRegistry(event);
      return await registry.writeSkillContent(skillId, content, workDir);
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('skills:delete', async (event, skillId: string) => {
    try {
      const { registry } = await getRegistry(event);
      return await registry.deleteSkill(skillId);
    } catch {
      return null;
    }
  });

  ipcMain.handle('skills:import-url', async (event, url: string, target: 'user' | 'workspace') => {
    try {
      const { registry, workDir } = await getRegistry(event);
      return await registry.importFromUrl(url, target, workDir);
    } catch {
      return null;
    }
  });

  ipcMain.handle('skills:import-path', async (event, sourcePath: string, target: 'user' | 'workspace', mode?: 'copy' | 'link') => {
    try {
      const { registry, workDir } = await getRegistry(event);
      return await registry.importFromPath(sourcePath, target, workDir, mode === 'link' ? 'link' : 'copy');
    } catch {
      return null;
    }
  });

  ipcMain.handle('skills:discover-external', async (event) => {
    try {
      const { registry, workDir } = await getRegistry(event);
      return registry.discoverExternalSkills(workDir);
    } catch {
      return [];
    }
  });

  ipcMain.handle('skills:get-dirs', async (event) => {
    const scope = projectManager.getBySender(event?.sender as any);
    const workDir = scope?.workspacePath ?? process.cwd();
    return {
      user: path.join(os.homedir(), NEOX_HOME_DIRNAME, 'skills'),
      workspace: path.join(workDir, '.neox', 'skills'),
    };
  });

  // ── 执行历史 (app-global, 不依赖 scope) ──

  ipcMain.handle('skills:get-history', async () => {
    try {
      return readHistory();
    } catch {
      return [];
    }
  });

  ipcMain.handle('skills:clear-history', async () => {
    try {
      clearHistory();
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  // ── K4-MVP: 商店安装 (install/update/uninstall/trust + list-installed) ──
  // 跟现有 skills:import-url 区别: K4 路径写 .neox-skill.json metadata, 默认 limited trust,
  // 支持 update 重新拉取 + trust 升级到 trusted (K2 联动).

  ipcMain.handle('skills:install', async (event, url: string, options?: { trustLevel?: 'trusted' | 'limited' }) => {
    const scope = projectManager.getBySender(event?.sender as any);
    /* 默认装到 ~/.neox/skills/ (user 级, 跨 project 共享); workspace 级少用, 留 future */
    return await skillInstallManager.install(url, {
      trustLevel: options?.trustLevel,
      target: 'user',
      workDir: scope?.workspacePath,
    });
  });

  /* A2: 装前预览 — UI 显示 author/version/allowedTools 给用户确认才点 Install. */
  ipcMain.handle('skills:preview-install', async (_event, url: string) => {
    /* url 支持远程 URL 或本地路径 (file:// / 绝对路径), installManager 内部判断 */
    if (url.startsWith('file://') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
      return skillInstallManager.previewLocal(url.startsWith('file://') ? url.slice(7) : url);
    }
    return await skillInstallManager.preview(url);
  });

  ipcMain.handle('skills:update', async (event, skillId: string) => {
    const scope = projectManager.getBySender(event?.sender as any);
    return await skillInstallManager.update(skillId, { workDir: scope?.workspacePath });
  });

  ipcMain.handle('skills:uninstall', async (event, skillId: string) => {
    const scope = projectManager.getBySender(event?.sender as any);
    return await skillInstallManager.uninstall(skillId, { workDir: scope?.workspacePath });
  });

  ipcMain.handle('skills:trust', async (event, skillId: string) => {
    const scope = projectManager.getBySender(event?.sender as any);
    return await skillInstallManager.trust(skillId, { workDir: scope?.workspacePath });
  });

  ipcMain.handle('skills:untrust', async (event, skillId: string) => {
    const scope = projectManager.getBySender(event?.sender as any);
    return await skillInstallManager.untrust(skillId, { workDir: scope?.workspacePath });
  });

  ipcMain.handle('skills:list-installed', async (event) => {
    const scope = projectManager.getBySender(event?.sender as any);
    /* 只列有 .neox-skill.json 的 (= K4 装的); builtin / 老 importFromUrl 装的不显示在这.
     * 给 Settings UI 区分 "商店装的" 跟 "内置 / 我的". */
    return skillInstallManager.listInstalled({ workDir: scope?.workspacePath });
  });
}
