/**
 * createJvmBackend — Electron main 侧的 BackendFactory 工厂.
 *
 * 真正注册用 {@link makeJvmBackendFactory}(scope) — 它读 scope 里的 DebugService
 * 把现存断点在 configurationDone 之前一次性推给 jvm-debugger.
 *
 * 裸 createJvmBackend 留着给测试 / 没 scope 上下文的场景用 (永远不推断点).
 */

import { randomUUID } from 'node:crypto';

import { JvmDapBackend } from './JvmDapBackend.js';
import type { BackendFactory } from '../../../../ide/debug/index.js';
import type { JvmAttachConfig, JvmLaunchConfig, LineBreakpoint } from '../../../../ide/debug/index.js';
import type { ProjectScope } from '../../context/ProjectScope.js';
import { DEBUG_SERVICE } from '../../context/tokens.js';
import { DapClient } from './DapClient.js';
import { locateJvmDebugger } from './jvmDebuggerLocator.js';

export const createJvmBackend: BackendFactory = async (config) =>
  buildBackend(config, /* beforeConfigDone */ undefined);

/** 带 scope 的版本: 能读 DebugService, 提供 initial breakpoint sync. */
export function makeJvmBackendFactory(scope: ProjectScope): BackendFactory {
  return async (config) => {
    return buildBackend(config, async (session) => {
      const svc = scope.tryGetService(DEBUG_SERVICE);
      if (!svc) return;
      const all = svc.getAllBreakpoints?.() ?? [];
      const byFile = new Map<string, typeof all>();
      for (const bp of all) {
        if (!bp.enabled) continue;
        const list = byFile.get(bp.file) ?? [];
        list.push(bp);
        byFile.set(bp.file, list);
      }
      for (const [file, bps] of byFile) {
        const lineBps: LineBreakpoint[] = bps.map((bp) => ({
          id: bp.id,
          type: 'line' as const,
          file: bp.file,
          line: bp.line,
          enabled: bp.enabled,
          condition: bp.condition,
          hitCondition: bp.hitCondition,
          logMessage: bp.logMessage,
        }));
        try {
          await session.setLineBreakpoints(file, lineBps);
        } catch (err) {
          console.warn(`[JvmBackendFactory] initial bp sync failed for ${file}:`, err);
        }
      }
    });
  };
}

async function buildBackend(
  config: JvmLaunchConfig | JvmAttachConfig | { kind: string },
  onBeforeConfigurationDone: ((session: import('../../../../ide/debug/index.js').DebugSession) => Promise<void>) | undefined,
) {
  if (config.kind !== 'jvm-launch' && config.kind !== 'jvm-attach') {
    throw new Error(`createJvmBackend: unsupported kind=${config.kind}`);
  }
  const location = locateJvmDebugger();
  const client = new DapClient({
    command: location.javaExe,
    args: location.args,
    onStderr: (text) => {
      process.stderr.write(text.startsWith('[neox-jvm-debugger]') ? text : `[jvm-dbg] ${text}`);
    },
  });
  return new JvmDapBackend(config as JvmLaunchConfig | JvmAttachConfig, {
    client,
    sessionId: randomUUID(),
    onBeforeConfigurationDone,
  });
}
