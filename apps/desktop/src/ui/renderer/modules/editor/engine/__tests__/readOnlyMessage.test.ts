
import { describe, expect, test } from 'vitest';
import { getNeoxCodeEditorOptions } from '../options';

describe('只读提示', () => {
  test('只读时给中文 readOnlyMessage', () => {
    const o = getNeoxCodeEditorOptions({ readOnly: true });
    expect(o.readOnly).toBe(true);
    expect(o.readOnlyMessage?.value, '只读编辑器没有自定义提示 = 会露出 Monaco 的英文原文')
      .toMatch(/[一-龥]/);
  });

  test('提示要指出出路 (让 Agent 改 / 终端), 不能只说"不能编辑"', () => {
    const v = getNeoxCodeEditorOptions({ readOnly: true }).readOnlyMessage?.value ?? '';
    expect(v).toMatch(/Agent|终端/);
  });

  test('默认就是只读 —— 这套 options 是给 surface 查看器用的', () => {
    expect(getNeoxCodeEditorOptions().readOnly).toBe(true);
    expect(getNeoxCodeEditorOptions().readOnlyMessage).toBeTruthy();
  });

  test('可编辑时不要挂只读提示', () => {
    const o = getNeoxCodeEditorOptions({ readOnly: false });
    expect(o.readOnly).toBe(false);
    expect(o.readOnlyMessage).toBeUndefined();
  });
});
