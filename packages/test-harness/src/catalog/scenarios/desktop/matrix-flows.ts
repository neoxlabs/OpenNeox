import type { Scenario } from '../../../types.js';
import { cart, flow, phase } from '../../gen/helpers.js';

/**
 * Extra Desktop matrix volume: composer modes × artifacts × window, etc.
 */

const AGENT_MODES = ['ask', 'code', 'agent'] as const;
const QUICK_TASKS = [
  { key: 'html', prompt: '写一个最小 html 文件并打开预览' },
  { key: 'md', prompt: '写一段 markdown 说明并打开' },
  { key: 'shell', prompt: '执行 echo DESK_MX_OK' },
  { key: 'read', prompt: '读一个源码文件摘要' },
] as const;

function modeTaskMatrix(): Scenario[] {
  const out: Scenario[] = [];
  for (const [mode, task] of cart([...AGENT_MODES], [...QUICK_TASKS])) {
    out.push(
      flow({
        id: `desktop.mx.mode-${mode}__task-${task.key}`,
        module: 'desktop.agent-flow',
        surface: 'desktop',
        title: `模式 ${mode} × 任务 ${task.key}`,
        why: '模式切换后能力边界（拒写/要批）必须正确',
        combo: ['matrix', 'mode', mode, task.key],
        mustNot: ['ask 模式静默改生产文件', 'code 模式该批不批或反过来无反馈'],
        priority: mode === 'ask' && task.key === 'html' ? 'P0' : 'P1',
        estimateMin: 10,
        steps: [
          phase('M0', `切换 agent mode=${mode}`, 'UI 显示当前模式', { severity: 'major' }),
          phase('M1', `发：「${task.prompt}」`, '行为符合该模式（执行/拒绝/要批）', {
            severity: 'blocker',
          }),
          phase('M2', '观察 timeline + composer', '状态可读；结束可继续', {
            assertUi: [{ type: 'state', target: 'composer', state: 'idle or awaiting clearly' }],
          }),
        ],
      }),
    );
  }
  return out;
}

const WIDTHS = [
  { key: 'wide', px: '≥1200' },
  { key: 'mid', px: '≈900' },
  { key: 'narrow', px: '≈640' },
] as const;

const LAYOUT_TASKS = [
  { key: 'chat-only', prep: '仅 timeline 对话 3 轮' },
  { key: 'with-html-surface', prep: '打开 html surface' },
  { key: 'with-approval', prep: '触发审批 dock' },
  { key: 'with-settings', prep: '打开设置覆盖层再关' },
] as const;

function layoutMatrix(): Scenario[] {
  const out: Scenario[] = [];
  for (const [w, t] of cart([...WIDTHS], [...LAYOUT_TASKS])) {
    out.push(
      flow({
        id: `desktop.mx.layout-${w.key}__${t.key}`,
        module: 'desktop.timeline-layout',
        surface: 'desktop',
        title: `布局 宽=${w.key} × ${t.key}`,
        why: '不同宽度+面板组合测对齐/遮挡',
        combo: ['matrix', 'layout', w.key, t.key],
        mustNot: ['composer 冲出', '最后一行被挡', '闪白'],
        priority: w.key === 'narrow' ? 'P0' : 'P1',
        estimateMin: 6,
        steps: [
          phase('L0', `窗口调到 ${w.px}；${t.prep}`, '布局可用', { severity: 'major' }),
          phase('L1', '对比 timeline 卡与 composer 外缘', '对齐或可接受窄屏折行', {
            assertUi: [{ type: 'geometry', rule: 'no unusable overlap' }],
          }),
          phase('L2', '发短消息「LAYOUT_OK」', '气泡完整可见', { severity: 'blocker' }),
        ],
      }),
    );
  }
  return out;
}

export const desktopMatrixFlows: Scenario[] = [...modeTaskMatrix(), ...layoutMatrix()];
