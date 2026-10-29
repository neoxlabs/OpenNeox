
import { describe, it, expect } from 'vitest';
import { isApprovalMode, dangerousOptions } from '../approvalModeStore';

describe('isApprovalMode · 只放行三个合法值', () => {
  it('三个合法模式全部放行', () => {
    expect(isApprovalMode('auto')).toBe(true);
    expect(isApprovalMode('manual')).toBe(true);
    expect(isApprovalMode('dangerous')).toBe(true);
  });

  it('大小写变体一律拒绝 —— 不做隐式归一, 免得掩盖上游写错', () => {
    for (const v of ['Auto', 'AUTO', 'Manual', 'DANGEROUS', 'Dangerous']) {
      expect(isApprovalMode(v), v).toBe(false);
    }
  });

  it('带空白的值拒绝', () => {
    expect(isApprovalMode(' auto')).toBe(false);
    expect(isApprovalMode('auto ')).toBe(false);
    expect(isApprovalMode('')).toBe(false);
  });

  it('近似值 / 历史别名一律拒绝', () => {
    for (const v of ['yolo', 'ask', 'readonly', 'none', 'off', 'on', 'default', 'auto-approve']) {
      expect(isApprovalMode(v), v).toBe(false);
    }
  });

  it('非字符串类型一律拒绝 (SQLite 里读回来的可能是任何东西)', () => {
    for (const v of [null, undefined, 0, 1, true, false, {}, [], NaN, () => {}]) {
      expect(isApprovalMode(v as unknown), String(v)).toBe(false);
    }
  });

  it('看似合法的对象包装拒绝', () => {
    expect(isApprovalMode({ mode: 'auto' })).toBe(false);
    expect(isApprovalMode(['auto'])).toBe(false);
    expect(isApprovalMode(new String('auto'))).toBe(false);
  });
});

describe('dangerousOptions · 只在真的带了确认时才透传', () => {
  const ack = { acknowledgeNoApproval: true, acknowledgeHighRiskExecution: true } as const;

  it('带确认时原样透传', () => {
    expect(dangerousOptions({ dangerousConfirmation: ack })).toEqual({ dangerousConfirmation: ack });
  });

  it('没带确认时返回空对象 —— 绝不能凭空造一个 confirmation 出来', () => {
    expect(dangerousOptions(undefined)).toEqual({});
    expect(dangerousOptions({})).toEqual({});
    expect(dangerousOptions({ dangerousConfirmation: undefined })).toEqual({});
  });

  it('返回值里不出现 undefined 键 —— 免得 IPC 序列化后变成显式 null', () => {
    expect(Object.keys(dangerousOptions(undefined))).toHaveLength(0);
  });
});
