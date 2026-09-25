/**
 * 极简终端仪表盘 —— 把 MonitorState 画成一屏文本, 周期性重绘。
 * 零依赖(只用 ANSI), 内部测试够用;web 仪表盘后续接同一份 MonitorState。
 */

import type { MonitorState, RenderState, AgentNode } from '../types.js';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

function stateColor(s: RenderState): string {
  switch (s) {
    case 'tool_running': return C.cyan;
    case 'thinking':
    case 'streaming': return C.blue;
    case 'completed': return C.green;
    case 'error': return C.red;
    case 'paused': return C.yellow;
    default: return C.gray;
  }
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  return `${(s / 60).toFixed(1)}m`;
}

function agentLine(a: AgentNode, now: number): string {
  const indent = '  '.repeat(a.depth);
  const branch = a.kind === 'main' ? '●' : (a.kind === 'background' ? '◐' : '↳');
  const col = stateColor(a.state);
  const tool = a.currentTool
    ? ` ${C.cyan}${a.currentTool}${C.reset}${a.toolElapsedMs ? ` ${C.dim}(${fmtMs(a.toolElapsedMs)})${C.reset}` : ''}`
    : '';
  const loop = a.loopInterventions > 0 ? ` ${C.yellow}loop×${a.loopInterventions}${C.reset}` : '';
  return `   ${indent}${branch} ${a.id.padEnd(16)} ${col}${a.state.padEnd(12)}${C.reset}`
    + ` ${C.dim}iter${a.iteration} tc${a.toolCalls}${C.reset}${tool}${loop}`;
}

export function renderDashboard(state: MonitorState): string {
  const now = Date.now();
  const lines: string[] = [];
  const conn = state.connected ? `${C.green}● connected${C.reset}` : `${C.red}○ disconnected${C.reset}`;
  const ep = state.endpoint ? `${state.endpoint.host}:${state.endpoint.port}` : '(no server found)';
  const modeTag = state.mode === 'attached' ? `${C.cyan}[deep]${C.reset}` : `${C.gray}[subscribe]${C.reset}`;

  lines.push(`${C.bold}NEOX AGENT MONITOR${C.reset} ${modeTag}  ${conn} ${C.dim}${ep}${C.reset}`);
  lines.push(`${C.dim}events=${state.eventsReceived}  updated=${new Date(state.lastUpdatedAt).toLocaleTimeString()}${C.reset}`);
  lines.push('');

  // 指标行
  const m = state.metrics;
  lines.push(
    `${C.bold}metrics${C.reset}  `
    + `sessions=${m.activeSessions} agents=${m.activeAgents} tools=${m.totalToolCalls} `
    + `lat p50=${fmtMs(m.toolLatencyP50)} p95=${fmtMs(m.toolLatencyP95)} `
    + `tok/min=${m.tokensPerMin} retries=${m.streamRetries} failover=${m.failovers}`,
  );

  // 控制平面(深度模式)
  if (state.controlPlane.available) {
    const stalls = state.controlPlane.inflightStalls;
    lines.push(
      `${C.bold}control${C.reset}  `
      + (stalls.length
        ? `${C.yellow}${stalls.length} in-flight: ${stalls.slice(0, 3).map(s => `${s.label}(${fmtMs(s.ageMs)})`).join(', ')}${C.reset}`
        : `${C.green}no stalls${C.reset}`),
    );
  }
  lines.push('');

  // session 拓扑
  lines.push(`${C.bold}sessions${C.reset}`);
  if (state.sessions.length === 0) {
    lines.push(`   ${C.dim}(no active sessions)${C.reset}`);
  }
  for (const s of state.sessions.slice(0, 6)) {
    const col = stateColor(s.state);
    const elapsed = fmtMs(now - s.startedAt);
    const ctx = s.ctxMax ? ` ${C.dim}ctx ${s.ctxUsed}/${s.ctxMax}${C.reset}` : '';
    lines.push(
      ` ${col}${s.state.padEnd(11)}${C.reset} ${C.bold}${s.sessionId.slice(0, 24)}${C.reset}`
      + ` ${C.dim}${elapsed} iter${s.iteration} tc${s.toolCalls}${C.reset}${ctx}`,
    );
    // 效率行
    const e = s.efficiency;
    lines.push(
      `     ${C.dim}eff:${C.reset} tok=${e.totalTokens} cache=${pctStr(e.cacheHitRate)}`
      + ` toolOK=${pctStr(e.toolSuccessRate)} iter≈${fmtMs(e.avgIterationMs)}`
      + ` think=${pctStr(e.thinkRatio)} repeat=${e.repeatToolCalls} compact=${e.compactions}`,
    );
    // 计划(逻辑路径)
    if (s.plan.length) {
      const done = s.plan.filter(p => p.status === 'completed').length;
      const cur = s.plan.find(p => p.status === 'in_progress');
      lines.push(`     ${C.dim}plan:${C.reset} ${done}/${s.plan.length}${cur ? ` ${C.cyan}▶ ${cur.step.slice(0, 50)}${C.reset}` : ''}`);
    }
    for (const a of s.agents.slice(0, 6)) {
      lines.push(agentLine(a, now));
    }
    // 最近路径(trace 尾巴)
    const tail = s.path.slice(-5);
    if (tail.length) {
      const trail = tail.map(n => pathGlyph(n)).join(` ${C.dim}→${C.reset} `);
      lines.push(`     ${C.dim}path:${C.reset} ${trail}`);
    }
    if (s.lastError) lines.push(`     ${C.red}! ${s.lastError.slice(0, 80)}${C.reset}`);
  }
  lines.push('');

  // 风控
  lines.push(`${C.bold}risk${C.reset} ${C.dim}highRisk=${state.metrics.highRiskToolCalls} approvals=${state.metrics.approvals} toolErr=${state.metrics.toolErrors}${C.reset}`);
  if (state.riskEvents.length === 0) lines.push(`   ${C.dim}(none)${C.reset}`);
  for (const r of state.riskEvents.slice(0, 6)) {
    const col = r.level === 'error' ? C.red : r.level === 'warn' ? C.yellow : C.gray;
    const t = new Date(r.ts).toLocaleTimeString();
    lines.push(`   ${col}[${r.kind}]${C.reset} ${C.dim}${t}${C.reset} ${r.message}`);
  }
  lines.push('');

  // 告警
  lines.push(`${C.bold}alerts${C.reset} ${C.dim}(latest)${C.reset}`);
  if (state.alerts.length === 0) {
    lines.push(`   ${C.dim}(none)${C.reset}`);
  }
  for (const a of state.alerts.slice(0, 6)) {
    const col = a.level === 'error' ? C.red : a.level === 'warn' ? C.yellow : C.gray;
    const t = new Date(a.ts).toLocaleTimeString();
    lines.push(`   ${col}[${a.kind}]${C.reset} ${C.dim}${t}${C.reset} ${a.message}`);
  }

  return lines.join('\n');
}

function pctStr(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function pathGlyph(n: { kind: string; label: string; ok?: boolean }): string {
  const c = n.kind === 'error' ? C.red : n.kind === 'tool' ? (n.ok === false ? C.red : C.cyan)
    : n.kind === 'plan' ? C.blue : n.kind === 'spawn' || n.kind === 'dag_node' ? C.yellow : C.gray;
  return `${c}${n.label.slice(0, 18)}${C.reset}`;
}

/** 清屏并重绘(alt-screen 风格) */
export function paint(state: MonitorState): void {
  // 移动到左上 + 清屏
  process.stdout.write('\x1b[H\x1b[2J');
  process.stdout.write(renderDashboard(state));
  process.stdout.write('\n');
}
