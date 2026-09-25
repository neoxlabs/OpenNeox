#!/usr/bin/env -S npx tsx
/**
 * neox-devtools CLI —— 内部测试用 agent 监控。
 *
 * 用法:
 *   neox-devtools monitor                      # 自动发现本机 server, 进程外纯订阅
 *   neox-devtools monitor --attach 127.0.0.1:4399 [--token xxx]
 *   neox-devtools monitor --workdir /path/to/project
 *   neox-devtools monitor --json              # 输出 JSON 快照流(给外部工具/web)
 *   neox-devtools list                        # 列出发现到的 server
 *
 * 这是纯外部工具:连产品本来就开着的 WSGateway, 产品零改动。
 */

import { discoverEndpoint, discoverEndpoints, parseManualTarget } from './discovery.js';
import { MonitorAggregator } from './aggregator.js';
import { MonitorClient } from './monitorClient.js';
import { paint } from './render/terminalDashboard.js';
import { serve } from './serve.js';
import type { ServerEndpoint } from './types.js';

interface Args {
  cmd: string;
  attach?: string;
  token?: string;
  workdir?: string;
  json: boolean;
  intervalMs: number;
  port: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cmd: argv[0] || 'monitor', json: false, intervalMs: 1000, port: 7399 };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--attach') args.attach = argv[++i];
    else if (a === '--token') args.token = argv[++i];
    else if (a === '--workdir') args.workdir = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--port') args.port = parseInt(argv[++i], 10) || 7399;
    else if (a === '--interval') args.intervalMs = parseInt(argv[++i], 10) || 1000;
  }
  return args;
}

function resolveEndpoint(args: Args): ServerEndpoint | null {
  if (args.attach) return parseManualTarget(args.attach, args.token);
  return discoverEndpoint(args.workdir);
}

function cmdList(): void {
  const eps = discoverEndpoints();
  if (eps.length === 0) {
    console.log('No running Neox server found (~/.neox/server*.pid).');
    return;
  }
  console.log(`Found ${eps.length} server(s):`);
  for (const e of eps) {
    console.log(`  · ${e.host}:${e.port}  pid=${e.pid ?? '?'}  token=${e.token ? '***' : '(none)'}  ${e.workDir ?? ''}`);
  }
}

function cmdMonitor(args: Args): void {
  const endpoint = resolveEndpoint(args);
  if (!endpoint) {
    console.error('No Neox server found. Start the app/CLI first, or use --attach host:port.');
    process.exit(1);
  }

  const aggregator = new MonitorAggregator();
  const logs: string[] = [];
  const client = new MonitorClient({
    endpoint,
    aggregator,
    statusPollMs: 5000,
    onLog: (m) => { logs.push(m); if (logs.length > 20) logs.shift(); },
  });
  client.start();

  const tick = () => {
    const state = aggregator.snapshot();
    if (args.json) {
      process.stdout.write(JSON.stringify(state) + '\n');
    } else {
      paint(state);
    }
  };

  const timer = setInterval(tick, args.intervalMs);
  tick();

  const shutdown = () => {
    clearInterval(timer);
    client.stop();
    process.stdout.write('\n');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  switch (args.cmd) {
    case 'list': cmdList(); break;
    case 'monitor': cmdMonitor(args); break;
    case 'serve':
      serve({ port: args.port, attach: args.attach, token: args.token, workdir: args.workdir, intervalMs: args.intervalMs });
      break;
    default:
      console.log('Usage: neox-devtools <monitor|serve|list> [--attach host:port] [--token t] [--workdir dir] [--port 7399] [--json] [--interval ms]');
      process.exit(args.cmd === 'help' ? 0 : 1);
  }
}

main();
