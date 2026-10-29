import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { ChatRequest, RuntimeBridge } from '../index.js';
import type { AgentRunMode } from '../../runtime/modeFactory.js';
import type { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import type { AgenticRuntime } from '../../runtime/agenticRuntime.js';

type HostBridgeMethods = Pick<
  RuntimeBridge,
  | 'getHostStatus'
  | 'getHostAgents'
  | 'getHostActivity'
  | 'getHostSession'
  | 'getHostSystem'
  | 'hostInterrupt'
  | 'hostSendCommand'
>;

interface CreateHostBridgeHandlersOptions {
  workDir: string;
  activeSessions: Set<string>;
  abortControllers: Map<string, AbortController>;
  getCurrentMode: () => AgentRunMode;
  memory: ShortTermMemory;
  singleRuntime: AgenticRuntime | null;
  assistantRuntime?: null;
  chat: (sessionId: string, request: ChatRequest) => Promise<void>;
}

export function createHostBridgeHandlers(options: CreateHostBridgeHandlersOptions): HostBridgeMethods {
  const {
    workDir,
    activeSessions,
    abortControllers,
    getCurrentMode,
    memory,
    singleRuntime,
    chat,
  } = options;

  return {
    async getHostStatus() {
      return {
        isRunning: activeSessions.size > 0,
        currentTask: null,
        mode: getCurrentMode(),
        workingDirectory: workDir,
        uptime: Math.floor(process.uptime()),
        memoryUsage: {
          tokensUsed: memory.length,
          contextWindow: 128000,
          pressure: memory.length / 128000,
        },
      };
    },
    async getHostAgents() {
      return [{ id: 'main', role: 'main', status: activeSessions.size > 0 ? 'running' : 'idle' }];
    },
    async getHostActivity(_limit = 10) { return []; },
    async getHostSession() { return { messageCount: memory.length, tokensUsed: 0 }; },
    async getHostSystem() {
      let gitBranch: string | null = null;
      let gitStatus = 'unknown';
      try {
        const { execSync } = await import('child_process');
        try { gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: workDir, encoding: 'utf-8', timeout: 5000 }).trim(); } catch (err: any) { cliLogger.debug('HOST_BRIDGE', `git branch detect failed: ${err?.message}`); }
        try { gitStatus = execSync('git status --porcelain', { cwd: workDir, encoding: 'utf-8', timeout: 5000 }).trim().length === 0 ? 'clean' : 'dirty'; } catch (err: any) { cliLogger.debug('HOST_BRIDGE', `git status detect failed: ${err?.message}`); }
      } catch (err: any) { cliLogger.debug('HOST_BRIDGE', `child_process import failed: ${err?.message}`); }
      return { platform: process.platform, arch: process.arch, cwd: workDir, gitBranch, gitStatus, nodeVersion: process.version };
    },
    async hostInterrupt() {
      for (const [, ac] of abortControllers) ac.abort();
      singleRuntime?.abort();
      const interrupted = activeSessions.size > 0;
      activeSessions.clear();
      abortControllers.clear();
      return { interrupted };
    },
    async hostSendCommand(text) {
      const sessionId = `cmd-${Date.now()}`;
      chat(sessionId, { prompt: text }).catch(err => {
        cliLogger.error('SERVER', `hostSendCommand failed: ${err.message}`);
      });
      return { queued: true, sessionId };
    },
  };
}
