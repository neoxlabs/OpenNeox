import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';

// ==================== 数据类型 ====================

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

/* 四个标准阶段 (work:Q-09): 计划里每一步都该说清它属于哪一段 ——
 * 「读材料 / 核对 / 产出 / 自检」。没有阶段, 用户看到的只是一串「第一步…第二步…」,
 * 分不出是在收集信息、在写东西, 还是在验收。值就用中文, 免得模型在
 * 中文任务里自己发明一套英文标签。归一化时也认常见英文别名。 */
export const PLAN_STEP_PHASES = ['读材料', '核对', '产出', '自检'] as const;
export type PlanStepPhase = typeof PLAN_STEP_PHASES[number];

export interface PlanStep {
  step: string;           // 步骤描述 (5-7个词)
  status: PlanStepStatus; // 步骤状态
  phase?: PlanStepPhase;  // 标准阶段 (Q-09), 缺省 = 模型没标
  estimateSec?: number;   // 预计耗时秒数 (Q-07), 缺省 = 不显示预计
}

export interface UpdatePlanArgs {
  explanation?: string;   // 可选的说明文字
  plan: PlanStep[];       // 计划步骤列表
}

// ==================== Tool Definition ====================

/**
 * update_plan 工具定义（Codex风格）
 */
export const updatePlanToolDefinition = {
  name: 'update_plan',
  description: `Updates the task plan.

Provide an optional explanation and a list of plan items, each with a step and status.
At most one step can be in_progress at a time.

Rules:
- Keep step descriptions short (5-7 words)
- Only ONE step should be "in_progress" at any time
- Mark completed steps as "completed"
- Mark user-skipped steps as "skipped" (do not run them again)
- Update the plan whenever you complete a step or start a new one
- Give EVERY step a phase: 读材料 (gather material), 核对 (cross-check facts/numbers), 产出 (produce the deliverable), or 自检 (self-check the result before handing it over)
- Give every step a rough estimateSec (integer seconds) so the user can see how long it should take — e.g. 30 for a quick read, 300 for a long document`,

  parameters: {
    type: 'object' as const,
    properties: {
      explanation: {
        type: 'string' as const,
        description: 'Optional explanation for the plan update',
      },
      plan: {
        type: 'array' as const,
        description: 'The list of steps',
        items: {
          type: 'object' as const,
          properties: {
            step: {
              type: 'string' as const,
              description: 'Step description (5-7 words)',
            },
            status: {
              type: 'string' as const,
              enum: ['pending', 'in_progress', 'completed', 'skipped'],
              description: 'Step status: pending, in_progress, completed, or skipped (user asked to skip this step)',
            },
            phase: {
              type: 'string' as const,
              enum: [...PLAN_STEP_PHASES],
              description: 'Which standard stage this step belongs to: 读材料 (gather), 核对 (check), 产出 (produce), 自检 (verify)',
            },
            estimateSec: {
              type: 'number' as const,
              description: 'Rough expected duration in seconds (e.g. 30, 120, 600)',
            },
          },
          required: ['step', 'status'],
        },
      },
    },
    required: ['plan'],
  },
};


interface SessionPlanFrame {
  plan: PlanStep[];
  updatedAt: number;
}

const sessionPlanFrames = new Map<string, SessionPlanFrame>();
const actionFrameRunStarts = new Map<string, number>();

export function notifyActionFrameRunStart(sessionId: string | undefined | null): void {
  if (!sessionId) return;
  actionFrameRunStarts.set(sessionId, Date.now());
}

/** 仅测试用 — 清空 action-frame 内存态。 */
export function __resetActionFrameStateForTesting(): void {
  sessionPlanFrames.clear();
  actionFrameRunStarts.clear();
}

/**
 * 构建每轮 action-frame prompt。无可注入内容时返回 null (kernel no-op):
 *   · 会话无 plan / plan 早于本次 run / plan 全部完成 → null
 */
export function getActionFramePrompt(sessionId: string | undefined | null): string | null {
  if (!sessionId) return null;
  const frame = sessionPlanFrames.get(sessionId);
  if (!frame) return null;
  const runStart = actionFrameRunStarts.get(sessionId);
  if (!runStart || frame.updatedAt < runStart) return null;

  const total = frame.plan.length;
  const completed = frame.plan.filter((s) => s.status === 'completed').length;
  const current = frame.plan.find((s) => s.status === 'in_progress');
  const pending = frame.plan.filter((s) => s.status === 'pending');
  if (!current && pending.length === 0) return null; /* 全部完成 — 别再催 */

  let isEn = false;
  try { isEn = (loadConfig() as any).language === 'en'; } catch { /* 默认 zh */ }

  const pendingPreview = pending.slice(0, 2).map((s) => s.step).join(' / ');
  const pendingSuffix = pending.length > 2 ? ` (+${pending.length - 2})` : '';

  if (isEn) {
    return [
      `[Plan · ${completed}/${total} done]`,
      current
        ? `Current step: ${current.step}.`
        : 'No step marked in_progress — update_plan to mark the one you are on.',
      pending.length > 0 ? `Remaining: ${pendingPreview}${pendingSuffix}.` : '',
      'Keep driving the current step; when it lands, mark it completed in update_plan and start the next. Do not re-plan finished work, do not ask whether to continue.',
    ].filter(Boolean).join(' ');
  }
  return [
    `[计划 · 已完成 ${completed}/${total}]`,
    current
      ? `当前步骤: ${current.step}。`
      : '没有步骤标记 in_progress —— 先 update_plan 标出你正在做的那一步。',
    pending.length > 0 ? `待办: ${pendingPreview}${pendingSuffix}。` : '',
    '继续推进当前步骤; 做完就在 update_plan 里标 completed 并进入下一步。不要重新规划已完成的部分, 不要问是否继续。',
  ].filter(Boolean).join(' ');
}

/**
 * 本次 run 内更新过、还没做完的步骤 —— 收尾闸 (runtimeBuilder) 用。没有 plan / plan 陈旧 / 全做完 → []。
 * 跟 getActionFramePrompt 同一个门控: 上个任务遗留的 plan 不算。
 */
export function getUnfinishedPlanSteps(sessionId: string | undefined | null): string[] {
  if (!sessionId) return [];
  const frame = sessionPlanFrames.get(sessionId);
  const runStart = actionFrameRunStarts.get(sessionId);
  if (!frame || !runStart || frame.updatedAt < runStart) return [];
  /* skipped 不算未完成 —— 否则用户点了「跳过」, 收尾闸还会一直催模型去做那一步 (Q-06) */
  return frame.plan.filter((s) => s.status !== 'completed' && s.status !== 'skipped').map((s) => s.step);
}

// ==================== Tool Handler ====================

const STATUS_GLYPH: Record<PlanStepStatus, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '✓',
  skipped: '⊗',
};

/** 把 plan 序列化成 markdown — 行业通用 GFM 复选框, 用 ✓ / ◐ / ○ 单色 glyph (跟 op_chip 风格一致) */
function renderPlanMarkdown(args: UpdatePlanArgs, sessionId?: string): string {
  const now = new Date().toISOString();
  const head: string[] = ['# Plan', ''];
  head.push(`_updated: ${now}_`);
  if (sessionId) head.push(`_session: ${sessionId}_`);
  head.push('');
  if (args.explanation && args.explanation.trim()) {
    head.push(`> ${args.explanation.trim().replace(/\n/g, '\n> ')}`);
    head.push('');
  }
  const body = args.plan.map(step => {
    const glyph = STATUS_GLYPH[step.status] || '○';
    const phase = step.phase ? `[${step.phase}] ` : '';
    const est = step.estimateSec ? `  (~${formatEstimate(step.estimateSec)})` : '';
    return `- ${glyph}  ${phase}${step.step}${est}`;
  });
  return [...head, ...body, ''].join('\n');
}

const PLAN_ARRAY_KEYS = ['plan', 'steps', 'todos', 'plan_steps', 'items'];
const PLAN_WRAPPER_KEYS = ['args', 'arguments', 'input', 'params', 'parameters'];
const PLAN_STEP_TEXT_KEYS = ['step', 'content', 'title', 'description', 'text'];

function coercePlanStatus(v: unknown): PlanStepStatus {
  return v === 'completed' || v === 'in_progress' || v === 'pending' || v === 'skipped' ? v : 'pending';
}

/** 模型偶尔把阶段写成英文 / 近义词 —— 能对上就归一, 对不上就当没标 (Q-09 不设硬闸)。 */
const PLAN_PHASE_ALIASES: Record<string, PlanStepPhase> = {
  '读材料': '读材料', read: '读材料', reading: '读材料', research: '读材料', gather: '读材料', input: '读材料',
  '核对': '核对', check: '核对', checking: '核对', crosscheck: '核对', compare: '核对', factcheck: '核对',
  '产出': '产出', produce: '产出', production: '产出', write: '产出', writing: '产出', build: '产出', output: '产出',
  '自检': '自检', verify: '自检', verification: '自检', review: '自检', test: '自检', selfcheck: '自检',
};

function coercePlanPhase(v: unknown): PlanStepPhase | undefined {
  if (typeof v !== 'string') return undefined;
  const key = v.trim().toLowerCase().replace(/[\s_-]/g, '');
  return PLAN_PHASE_ALIASES[key];
}

/** 预计时长: 正数秒, 上限一小时 (计划步骤不会更久); 其它一律当没给。 */
function coerceEstimateSec(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(3600, Math.round(n));
}

/** 「约 30s / 约 2m / 约 1h5m」—— 给落盘的 plan.md 用 */
function formatEstimate(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

/**
 * 从任意形态的 tool args 里抽出 update_plan 参数。
 * 拿不到可用的 plan 数组时返回 null —— 调用方据此回结构化 error, 不抛。
 */
function normalizeUpdatePlanArgs(raw: unknown): UpdatePlanArgs | null {
  let node: unknown = raw;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof node === 'string') {
      try { node = JSON.parse(node); } catch { return null; }
      continue;
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const obj = node as Record<string, unknown>;

    const arrKey = PLAN_ARRAY_KEYS.find(k => Array.isArray(obj[k]));
    if (arrKey) {
      const plan: PlanStep[] = (obj[arrKey] as unknown[]).map((item) => {
        if (typeof item === 'string') return { step: item.trim(), status: 'pending' as PlanStepStatus };
        const it = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        const textKey = PLAN_STEP_TEXT_KEYS.find(k => typeof it[k] === 'string' && String(it[k]).trim());
        const phase = coercePlanPhase(it.phase);
        const estimateSec = coerceEstimateSec(it.estimateSec ?? it.estimate_sec ?? it.estimatedSec);
        return {
          step: textKey ? String(it[textKey]).trim() : '',
          status: coercePlanStatus(it.status),
          ...(phase ? { phase } : {}),
          ...(estimateSec ? { estimateSec } : {}),
        };
      });
      /* 有步骤读不出文本 → 画出来是一行行空白, 让模型重传比留脏数据好 */
      if (plan.some(s => !s.step)) return null;
      return {
        explanation: typeof obj.explanation === 'string' ? obj.explanation : undefined,
        plan,
      };
    }

    /* plan 值本身被序列化成字符串 ({ plan: "[{\"step\":…}]" }) → 先解回数组再走一遍 */
    const strKey = PLAN_ARRAY_KEYS.find(
      k => typeof obj[k] === 'string' && String(obj[k]).trim().startsWith('['),
    );
    if (strKey) {
      try {
        node = { ...obj, [strKey]: JSON.parse(String(obj[strKey])) };
      } catch {
        return null;
      }
      continue;
    }

    /* 包装层: { name:'update_plan', args:{ plan } } / { input } / { params } … */
    const wrapKey = PLAN_WRAPPER_KEYS.find(k => obj[k] && typeof obj[k] === 'object');
    if (!wrapKey) return null;
    node = obj[wrapKey];
  }
  return null;
}

/** 测试用: 直接验 phase / estimateSec 的归一化 (生产路径走 handleUpdatePlan) */
export const __normalizeUpdatePlanArgsForTesting = normalizeUpdatePlanArgs;

/**
 * 处理 update_plan 工具调用
 *
 * @returns 工具返回结果（参数不可用时回结构化 error, 不抛异常）
 */
export async function handleUpdatePlan(
  args: UpdatePlanArgs,
  opts?: { workspaceRoot?: string; sessionId?: string },
): Promise<string> {
  const normalized = normalizeUpdatePlanArgs(args);
  if (!normalized) {
    /* 抛出去会被上层包成一张 "Tool failed" 卡, 用户只看到一句 JS 内部错误;
     * 结构化 error 则能让模型下一轮带着正确参数重来。 */
    return JSON.stringify({
      success: false,
      error: 'Invalid update_plan arguments. Expected {"plan":[{"step":"…","status":"pending|in_progress|completed|skipped"}]}. Resend the full step list.',
    });
  }

  const { plan } = normalized;
  // 验证：最多只有一个 in_progress
  const inProgressCount = plan.filter(s => s.status === 'in_progress').length;

  if (inProgressCount > 1) {
    return JSON.stringify({
      success: false,
      error: 'At most one step can be in_progress at a time',
    });
  }

  /* 会话级内存态 — 供 perTurnInjector 的 action-frame 使用 (见上方注释)。
   * 存的必须是归一化后的数组: getActionFramePrompt 直接对 frame.plan 调 .filter。 */
  if (opts?.sessionId) {
    sessionPlanFrames.set(opts.sessionId, { plan, updatedAt: Date.now() });
  }

  let planPath: string | undefined;
  if (opts?.workspaceRoot && opts.sessionId) {
    try {
      const dir = neoxHome('plans');
      await fs.mkdir(dir, { recursive: true });
      planPath = path.join(dir, `${opts.sessionId}.md`);
      await fs.writeFile(planPath, renderPlanMarkdown(normalized, opts.sessionId), 'utf-8');
    } catch (err) {
      cliLogger.warn('UPDATE_PLAN', 'persist plan failed', { error: (err as Error).message });
      planPath = undefined;
    }
  }

  return JSON.stringify({
    success: true,
    message: 'Plan updated',
    ...(planPath ? { planPath } : {}),
  });
}

export interface CreateUpdatePlanToolOptions {
  /** 拉 workspace root 用 — 不传则 plan 不落盘, 行为退化到旧版纯内存 */
  getWorkspaceRoot?: () => string | undefined;
  /** 当前 sessionId — 用作落盘文件名, 不传时用 'current.md' */
  getSessionId?: () => string | undefined;
}

export function createUpdatePlanTool(options?: CreateUpdatePlanToolOptions): Tool {
  return {
    name: updatePlanToolDefinition.name,
    description: updatePlanToolDefinition.description,
    parameters: updatePlanToolDefinition.parameters,
    permission: {
      category: ToolCategory.READ,
      allowInAskMode: true,
    },
    async function(args: UpdatePlanArgs, ctx?: { sessionId?: string }) {
      return handleUpdatePlan(args, {
        workspaceRoot: options?.getWorkspaceRoot?.(),
        sessionId: ctx?.sessionId || options?.getSessionId?.(),
      });
    },
  };
}
