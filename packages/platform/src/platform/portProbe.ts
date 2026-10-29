/**
 * portProbe — 跨平台探测某个 pid 当前监听的 TCP 端口.
 *
 * 用法: execute_shell 起 bg 进程 2s 后调一次, 探到端口写回 ProcessManager.port,
 * 服务治理 UI / 端口冲突诊断都靠这个.
 *
 * 实现策略 (按可用性优先):
 *   1. macOS/Linux: lsof -aP -p <pid> -iTCP -sTCP:LISTEN -n -F n
 *      · 输出格式严格 (-F n), 解析简单
 *      · 大多数发行版都有 lsof
 *   2. Linux fallback: ss -tlnp 然后 grep pid
 *      · 比 lsof 快 5-10×, 但需要解析人类可读输出
 *      · 用于 lsof 缺席的 Alpine / 精简容器
 *   3. Windows: netstat -ano -p TCP
 *
 * 失败一律静默返回 undefined — 探不到端口不是错误 (worker / cron 类进程不监听端口很正常).
 */

import { execa } from 'execa';
import { getDescendantPidsAsync } from './processTree.js';

const PROBE_TIMEOUT_MS = 1500;

/**
 * 探一个进程 (**及其子孙**) 监听的 TCP 端口。
 *
 * 进程记录的 pid 可能只是 wrapper:
 *   · `npm run dev`  → npm 不监听, 端口在它 spawn 的 node 孙进程上
 *   · `mvn spring-boot:run` → 同理, 端口在 fork 出来的 JVM 上
 *   · `cd x && node y` → zsh 有时会 exec 掉自己 (于是能探到), 有时不会 (探不到)
 * 因此同时检查整棵进程树，并把所有 pid 交给 lsof 一次查询。
 *
 * 仍探不到的情况 (docker 端口在 daemon 那边、跨命名空间) 属于已知边界: 回落到
 * "活过 15s 就算服务" 的判据, 服务仍然可见, 只是没有端口链接。
 */
export async function probeListeningPort(pid: number): Promise<number | undefined> {
  if (!pid || pid <= 0) return undefined;
  let pidList = String(pid);
  try {
    const descendants = await getDescendantPidsAsync(pid);
    if (descendants.length > 0) pidList = [pid, ...descendants].join(',');
  } catch { /* 枚举失败: 退回只探自己 */ }

  // 1) lsof — macOS/Linux 通用
  try {
    const result = await execa('lsof', [
      '-aP',
      '-p', pidList,
      '-iTCP',
      '-sTCP:LISTEN',
      '-n',
      '-F', 'n',
    ], { timeout: PROBE_TIMEOUT_MS, reject: false });

    if (result.exitCode === 0 && result.stdout) {
      /* 输出长这样:
       *   p12345
       *   n*:3000
       *   n127.0.0.1:8088
       * 取第一个找到的端口. 一个进程 (树) 可能监听多个端口 (e.g. http + ws + HMR),
       * 取第一个作为"主端口"足够 UI 显示用. */
      for (const line of result.stdout.split('\n')) {
        if (!line.startsWith('n')) continue;
        const m = line.slice(1).match(/:(\d+)$/);
        if (m) return parseInt(m[1], 10);
      }
    }
  } catch {
    /* lsof 不存在或执行失败, 走 fallback */
  }

  // 2) Linux ss fallback
  if (process.platform === 'linux') {
    try {
      const result = await execa('ss', ['-tlnp'], {
        timeout: PROBE_TIMEOUT_MS,
        reject: false,
      });
      if (result.exitCode === 0 && result.stdout) {
        const pidTags = pidList.split(',').map(p => `pid=${p}`);
        for (const line of result.stdout.split('\n')) {
          if (!pidTags.some(tag => line.includes(tag))) continue;
          /* ss 行格式 (字段空格分隔, 第 4 列是 Local Address:Port):
           *   LISTEN 0 4096 0.0.0.0:3000  0.0.0.0:*  users:(("node",pid=12345,fd=20))
           *   LISTEN 0 4096 *:8088        *:*        users:(("java",pid=12346,fd=14)) */
          const m = line.match(/[\d.*\[\]:]+:(\d+)\s+/);
          if (m) return parseInt(m[1], 10);
        }
      }
    } catch {
      /* ss 也没有, 放弃 */
    }
  }

  // 3) Windows — netstat -ano 拿全局 LISTENING 表, 跟进程树 pid 求交集
  if (process.platform === 'win32') {
    /* netstat 提供 Windows 的监听端口和 owner pid；只接受进程树中的 pid，避免把其他服务
     * 的端口关联到当前任务。 */
    try {
      const result = await execa('netstat', ['-ano', '-p', 'TCP'], {
        timeout: PROBE_TIMEOUT_MS, reject: false, windowsHide: true,
      });
      if (result.stdout) {
        const pidSet = new Set(pidList.split(',').map(p => parseInt(p, 10)));
        for (const line of result.stdout.split('\n')) {
          if (!/LISTENING/i.test(line)) continue;
          /* TCP    0.0.0.0:8080     0.0.0.0:0     LISTENING     1234
           * 本地地址可能是 IPv6 形如 [::]:8080, 所以取"最后一个冒号后的数字"。 */
          const cols = line.trim().split(/\s+/);
          if (cols.length < 5) continue;
          const owner = parseInt(cols[cols.length - 1], 10);
          if (!pidSet.has(owner)) continue;
          const m = cols[1].match(/:(\d+)$/);
          if (m) return parseInt(m[1], 10);
        }
      }
    } catch {
      /* netstat 不可用: 回落到"活过 15s 算服务", 面板仍看得到, 只是没有端口链接 */
    }
  }
  return undefined;
}

/** dev-server / watcher / 服务进程类命令的启发模式.
 *
 *  覆盖三类:
 *    1. 持续 watcher: --watch / --serve / nodemon / tail -f / *--reload*
 *    2. 命名 dev server: vite / next dev / rails s / webpack serve / docker compose up
 *    3. 主流后端启动: mvn spring-boot:run / gradle bootRun / npm run dev / yarn dev / pnpm dev
 *       / npm start / python -m (http.server|flask|...) / flask run / django runserver
 *       / rails server / hapi / fastify / express start / uvicorn / gunicorn / node server.js
 *
 *  命中 = "这是个工程级长期服务", 关 Neox 不杀, 跨重启接管. */
const DEV_COMMAND_PATTERN = /(?:^|\s)--(?:watch|serve|reload)\b|\b(nodemon|tail\s+-[fF]|docker[\s-]compose\s+up|webpack[\s-]+serve|vite|next\s+(?:dev|start)|rails\s+s(?:erver)?|spring-boot:run|bootRun|gradlew?\s+\S*(?:bootRun|run|server)|npm\s+(?:run\s+(?:dev|start|serve|watch)|start)|yarn\s+(?:dev|start|serve|watch)|pnpm\s+(?:dev|start|serve|watch)|python3?\s+-m\s+(?:http\.server|flask|uvicorn|gunicorn)|flask\s+run|django(?:-admin)?\s+runserver|hypercorn|daphne|uvicorn|gunicorn|node\s+\S*(?:server|index|app|main)\.[mc]?[jt]sx?|deno\s+(?:run|task)\s+\S*(?:dev|start|serve))\b/i;

/** 一次性构建/安装类命令黑名单:
 *  这些命令即使跑得久也是 build/install, 绝不是服务 — 静态启发必须先排除,
 *  否则 `vite build` 蹭上 DEV pattern 里的 "vite"、`gradlew build` 蹭上 run 之类误判。
 *  端口/RunConfig 等运行时强证据不受此影响 (classifyProcess 里优先级更高)。 */
const ONE_SHOT_COMMAND_PATTERN = new RegExp([
  /\b(?:npm|yarn|pnpm|bun)\s+(?:install|ci|add|remove|update|upgrade|audit|link|publish)\b/.source,
  /\b(?:npm|yarn|pnpm|bun)\s+run\s+(?:build|lint|test|typecheck|type-check|check|compile|format|clean)\b/.source,
  /\bmvn\b[^|;&]*\s(?:package|compile|install|verify|deploy|test)\b/.source,
  /\bgradlew?\b[^|;&]*\s(?:build|assemble|test|check|jar)\b/.source,
  /\b(?:vite|next|nuxt|astro|tsup|rollup|esbuild)\s+build\b/.source,
  /\btsc\b(?![^|;&]*--watch)/.source,
  /\bwebpack\b(?![^|;&]*(?:serve|--watch))/.source,
  /\bdocker\s+build\b|\bdocker[\s-]compose\s+build\b/.source,
  /\bgo\s+(?:build|test|vet|generate|install)\b/.source,
  /\bcargo\s+(?:build|check|test|clippy|install)\b/.source,
  /\b(?:pip3?|pipx|brew|apt(?:-get)?|gem|composer)\s+(?:install|upgrade|update)\b/.source,
].join('|'), 'i');

/** 显式服务标记 — 混合命令 (e.g. `mvn clean package spring-boot:run`) 里出现这些
 *  说明最终意图是起服务, 黑名单让位。 */
const SERVER_OVERRIDE_PATTERN = /\b(spring-boot:run|bootRun|runserver|dev-?server|compose\s+up)\b|(?:^|\s)--(?:watch|serve|reload)\b/i;

export function isLikelyLongRunningCommand(command: string): boolean {
  if (ONE_SHOT_COMMAND_PATTERN.test(command) && !SERVER_OVERRIDE_PATTERN.test(command)) {
    return false;
  }
  return DEV_COMMAND_PATTERN.test(command);
}
