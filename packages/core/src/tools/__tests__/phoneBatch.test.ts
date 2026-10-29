/**
 * pilot:D-05 —— phone 工具的 batch 动作只做转发: 模型一次调用, 手机按顺序做几步.
 *
 * 真正的顺序执行 / 失败即停 / 最后整屏在手机端 (apps/mobile/lib/core/local_agent/tools/phone_batch.dart),
 * 这里盯住云端的入口: action 在枚举里、描述讲得清、steps 原样交给节点执行器。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PHONE_ACTIONS, phoneTool, setPhoneExecutor, type PhoneExecRequest } from '../phoneTools.js';

describe('phone batch', () => {
  afterEach(() => setPhoneExecutor(null));

  it('batch 在动作枚举里, 描述说明它一次做几步', () => {
    expect(PHONE_ACTIONS).toContain('batch');
    expect(phoneTool.description).toContain('- batch {steps:');
    expect(phoneTool.description).toContain('max 12');
  });

  it('steps 原样转给手机节点, 结果照实回给模型', async () => {
    const seen: PhoneExecRequest[] = [];
    setPhoneExecutor(async (req) => {
      seen.push(req);
      return { ok: true, output: '批量 3 步全部完成 (没有失败):\n1. phone_ui tap → 在点按\n最终屏幕 (整屏):\n[1] 按钮 「提交订单」' };
    });

    const steps = [
      { op: 'tap', target: 3 },
      { tool: 'phone_ui', args: { op: 'type', target: 4, text: '珍珠奶茶' } },
      { tool: 'open_app', args: { op: 'open', package: 'me.ele' } },
    ];
    const raw = await phoneTool.function!({ action: 'batch', args: { steps } }, {} as never);
    const out = JSON.parse(String(raw)) as { success: boolean; result?: string };

    expect(out.success).toBe(true);
    expect(out.result).toContain('批量 3 步全部完成');
    expect(seen).toHaveLength(1);
    expect(seen[0].tool).toBe('batch');
    expect(seen[0].args).toEqual({ steps });
  });

  it('节点说失败就照实回 success:false', async () => {
    setPhoneExecutor(async () => ({ ok: false, output: '批量 2 步: 第 2 步失败, 后面 0 步没做。' }));

    const raw = await phoneTool.function!({ action: 'batch', args: { steps: [{ op: 'tap', target: 1 }] } }, {} as never);
    const out = JSON.parse(String(raw)) as { success: boolean; error?: string };

    expect(out.success).toBe(false);
    expect(out.error).toContain('第 2 步失败');
  });

  it('没有手机执行器时如实说不可用', async () => {
    setPhoneExecutor(null);
    const raw = await phoneTool.function!({ action: 'batch', args: { steps: [{ op: 'tap', target: 1 }] } }, {} as never);
    const out = JSON.parse(String(raw)) as { success: boolean; error?: string };
    expect(out.success).toBe(false);
    expect(out.error).toContain('paired phone');
  });
});
