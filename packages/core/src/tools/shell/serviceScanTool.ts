
import { execSync } from 'child_process';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getToolServices } from '../runtimeToolServices.js';

// ============================================================================
// Types
// ============================================================================

interface ListeningService {
  pid: number;
  command: string;
  port: number;
  protocol: string;
  /** 是否已被 Neox processManager 追踪 */
  tracked: boolean;
}

interface MatchedProcess {
  pid: number;
  command: string;
  /** 进程已运行时长 (human-readable) */
  elapsed: string;
  cpu: string;
  mem: string;
  tracked: boolean;
}

interface ServiceScanResult {
  /** 监听中的端口和服务 */
  listening: ListeningService[];
  /** 按关键词匹配的进程 */
  processes: MatchedProcess[];
  /** Neox processManager 里已追踪的后台进程 */
  neox_tracked: Array<{ pid: number; command: string; status: string; uptime_ms: number }>;
  /** 人类可读摘要 */
  summary: string;
}

// ============================================================================
// 常见 dev 服务的端口 & 进程关键词
// ============================================================================

/** 常见 dev 服务端口范围 */
const DEV_PORT_RANGES: Array<[number, number]> = [
  [3000, 3010],   // React / Next.js / Express
  [4000, 4010],   // Gatsby / GraphQL
  [5000, 5010],   // Flask / Vite preview
  [5170, 5180],   // Vite dev
  [8000, 8010],   // Django / uvicorn
  [8080, 8090],   // Webpack / generic
  [9000, 9010],   // PHP / misc
  [4200, 4210],   // Angular
  [1234, 1240],   // Parcel
  [6006, 6010],   // Storybook
  [24678, 24680], // Vite HMR
];

function isDevPort(port: number): boolean {
  return DEV_PORT_RANGES.some(([lo, hi]) => port >= lo && port <= hi);
}

/** 进程匹配关键词 — 只匹配 dev server / build 类进程 */
const SERVICE_PROCESS_PATTERNS = [
  'node.*(?:next|vite|webpack|react-scripts|nuxt|gatsby|express|koa|fastify|nest)',
  'npm\\s+run\\s+(?:dev|start|serve|watch|build)',
  'yarn\\s+(?:dev|start|serve|watch|build)',
  'pnpm\\s+(?:dev|start|serve|watch|build)',
  'nodemon',
  'ts-node',
  'tsx\\s+watch',
  'uvicorn',
  'gunicorn',
  'flask\\s+run',
  'python.*manage\\.py\\s+runserver',
  'cargo\\s+(?:run|watch)',
  'go\\s+run',
  'docker-compose\\s+up',
  'docker\\s+compose\\s+up',
];

// ============================================================================
// 系统扫描实现
// ============================================================================

function scanListeningPorts(): ListeningService[] {
  const results: ListeningService[] = [];
  try {
    // macOS / Linux: lsof
    const raw = execSync(
      'lsof -i -P -n -sTCP:LISTEN 2>/dev/null || ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null',
      { timeout: 3000, encoding: 'utf8', maxBuffer: 512 * 1024 },
    );

    for (const line of raw.split('\n').slice(1)) { // skip header
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) continue;

      // lsof format: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
      const command = parts[0];
      const pid = parseInt(parts[1], 10);
      const name = parts[parts.length - 1]; // e.g. *:3000 or 127.0.0.1:5173

      if (!pid || isNaN(pid)) continue;

      const portMatch = name.match(/:(\d+)$/);
      if (!portMatch) continue;
      const port = parseInt(portMatch[1], 10);

      // 过滤掉系统服务（只关心 dev 相关端口，或 command 匹配 dev 模式）
      const isDev = isDevPort(port) || /node|npm|yarn|pnpm|python|ruby|java|go|cargo|docker/i.test(command);
      if (!isDev) continue;

      results.push({
        pid,
        command: tryGetFullCommand(pid) || command,
        port,
        protocol: 'tcp',
        tracked: false, // 后面填充
      });
    }
  } catch {
    // lsof 不可用（权限不够等），不影响其他扫描
  }

  // 去重（同 pid 可能监听多个端口，合并为多条）
  const seen = new Set<string>();
  return results.filter(r => {
    const key = `${r.pid}:${r.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scanProcesses(extraKeywords?: string[]): MatchedProcess[] {
  const results: MatchedProcess[] = [];
  try {
    const patterns = [...SERVICE_PROCESS_PATTERNS];
    if (extraKeywords?.length) {
      patterns.push(...extraKeywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    // 用 ps 一次拿全，在 JS 侧过滤（比多次 pgrep 高效）
    const raw = execSync(
      'ps aux 2>/dev/null',
      { timeout: 3000, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );

    const combinedRegex = new RegExp(patterns.join('|'), 'i');
    const myPid = process.pid;

    for (const line of raw.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;

      const pid = parseInt(parts[1], 10);
      if (!pid || pid === myPid) continue;

      // 完整命令是第 10 列开始到行末
      const cmd = parts.slice(10).join(' ');

      if (!combinedRegex.test(cmd)) continue;
      // 排除自身和一些噪声
      if (/service_scan|grep|ps aux/i.test(cmd)) continue;

      results.push({
        pid,
        command: cmd.length > 200 ? cmd.slice(0, 200) + '...' : cmd,
        elapsed: parts[9] || '',
        cpu: parts[2] || '',
        mem: parts[3] || '',
        tracked: false,
      });
    }
  } catch {
    // ps 不可用
  }

  return results;
}

/** 尝试获取 pid 的完整命令行 */
function tryGetFullCommand(pid: number): string | null {
  try {
    // macOS: ps -p <pid> -o args=
    const cmd = execSync(`ps -p ${pid} -o args= 2>/dev/null`, {
      timeout: 1000, encoding: 'utf8',
    }).trim();
    return cmd.length > 200 ? cmd.slice(0, 200) + '...' : cmd;
  } catch {
    return null;
  }
}

/** 推断目标端口 — 从命令字符串中提取 */
export function inferTargetPort(command: string): number | null {
  // --port 3000 / -p 3000 / PORT=3000
  const portArgMatch = command.match(/(?:--port|--PORT|-p)\s+(\d+)/);
  if (portArgMatch) return parseInt(portArgMatch[1], 10);

  const envPortMatch = command.match(/\bPORT=(\d+)/);
  if (envPortMatch) return parseInt(envPortMatch[1], 10);

  // 常见框架默认端口推断
  if (/\bnext\s+dev\b/.test(command)) return 3000;
  if (/\bvite\b/.test(command)) return 5173;
  if (/\breact-scripts\s+start\b/.test(command)) return 3000;
  if (/\bwebpack.*dev.*server\b/i.test(command)) return 8080;
  if (/\bangular.*serve\b/i.test(command) || /\bng\s+serve\b/.test(command)) return 4200;
  if (/\bflask\s+run\b/.test(command)) return 5000;
  if (/\buvicorn\b/.test(command)) return 8000;
  if (/\bdjango.*runserver\b/.test(command)) return 8000;
  if (/\bgatsby\s+develop\b/.test(command)) return 8000;
  if (/\bnuxt\s+dev\b/.test(command)) return 3000;

  return null;
}

// ============================================================================
// Tool 定义
// ============================================================================

export const serviceScanTool: Tool = {
  name: 'service_scan',
  description: `Discover running services/processes on the system — ports, dev servers, builds, etc.

WHEN TO USE:
- **Before starting a dev server** (npm run dev, vite, uvicorn, etc.) — check if one is already running to avoid EADDRINUSE
- **User says "restart the server"** — find the existing process first, kill it, then restart
- **Diagnosing port conflicts** — see who is occupying a port
- **Taking over user-started services** — discover processes you didn't start, then use service_adopt to manage them

WHAT IT SCANS:
1. TCP listening ports (lsof) — finds all dev-related services with their ports and PIDs
2. Process list (ps) — matches dev server / build / watch patterns system-wide
3. Neox tracked processes — shows what's already under your management

The result tells you:
- Which services are already running (with PID, port, command)
- Which ones are already tracked by Neox (you can bash_output/bash_kill them)
- Which ones are NOT tracked (use service_adopt to take over)

Parameters:
- port (optional): check a specific port
- keywords (optional): extra process keywords to scan for (e.g. ["redis", "postgres"])
- command_hint (optional): the command you plan to run — the tool will check if a similar service already exists`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,
  aliases: ['scan_services', 'detect_services', 'port_check', 'list_services'],

  parameters: {
    type: 'object',
    properties: {
      port: {
        type: 'number',
        description: 'Check if a specific port is in use',
      },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional process keywords to scan for (e.g. ["redis", "postgres"])',
      },
      command_hint: {
        type: 'string',
        description: 'The command you plan to run. The tool will check if a similar service is already running and infer the target port.',
      },
    },
    required: [],
  },

  async function(args: { port?: number; keywords?: string[]; command_hint?: string }): Promise<string> {
    const services = getToolServices();
    const pm = services.processManager;

    // 1. 扫描端口
    let listening = scanListeningPorts();

    // 2. 扫描进程
    const processes = scanProcesses(args?.keywords);

    // 3. 标记已被 Neox 追踪的
    const trackedPids = new Set(pm.getAll().map(p => p.pid));
    for (const s of listening) s.tracked = trackedPids.has(s.pid);
    for (const p of processes) p.tracked = trackedPids.has(p.pid);

    // 4. Neox 内部追踪列表
    const neoxTracked = pm.getBackgroundRunning().map(p => ({
      pid: p.pid,
      command: p.command.length > 120 ? p.command.slice(0, 120) + '...' : p.command,
      status: p.status,
      uptime_ms: Date.now() - p.startTime.getTime(),
    }));

    // 5. 如果指定了 port，过滤
    if (args?.port) {
      listening = listening.filter(s => s.port === args.port);
    }

    // 6. 如果有 command_hint，做智能匹配
    let commandHintMatch: string | null = null;
    if (args?.command_hint) {
      const targetPort = inferTargetPort(args.command_hint);
      if (targetPort) {
        const portHit = listening.find(s => s.port === targetPort);
        if (portHit) {
          commandHintMatch = `Port ${targetPort} already in use by pid=${portHit.pid} (${portHit.command.slice(0, 80)}). ` +
            (portHit.tracked
              ? `Already tracked — use bash_output(${portHit.pid}) to read, bash_kill(${portHit.pid}) to stop.`
              : `NOT tracked — use service_adopt(pid=${portHit.pid}) to take over, or bash_kill after adopting.`);
        }
      }

      // 也按命令相似度匹配
      const hintNorm = args.command_hint.trim().replace(/\s+/g, ' ');
      const cmdMatch = processes.find(p => {
        const pNorm = p.command.trim().replace(/\s+/g, ' ');
        // 模糊匹配：核心 token 重叠
        const hintTokens = hintNorm.split(' ').filter(t => t.length > 2);
        const matchCount = hintTokens.filter(t => pNorm.includes(t)).length;
        return matchCount >= Math.min(2, hintTokens.length);
      });
      if (cmdMatch && !commandHintMatch) {
        commandHintMatch = `Similar process already running: pid=${cmdMatch.pid} (${cmdMatch.command.slice(0, 80)}). ` +
          (cmdMatch.tracked
            ? `Already tracked.`
            : `NOT tracked — use service_adopt(pid=${cmdMatch.pid}) to take over.`);
      }
    }

    // 7. 构建摘要
    const parts: string[] = [];
    if (commandHintMatch) {
      parts.push(`⚠️ ${commandHintMatch}`);
    }
    if (listening.length > 0) {
      parts.push(`${listening.length} dev service(s) listening on ports: ${listening.map(s => `${s.port}(pid ${s.pid})`).join(', ')}`);
    }
    if (processes.length > 0) {
      const untracked = processes.filter(p => !p.tracked);
      parts.push(`${processes.length} matching process(es) found${untracked.length ? `, ${untracked.length} not tracked by Neox` : ''}`);
    }
    if (neoxTracked.length > 0) {
      parts.push(`${neoxTracked.length} process(es) already tracked by Neox`);
    }
    if (parts.length === 0) {
      parts.push('No dev services detected.');
    }

    const result: ServiceScanResult = {
      listening,
      processes,
      neox_tracked: neoxTracked,
      summary: parts.join('\n'),
    };

    return JSON.stringify(result, null, 2);
  },
};
