import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(HERE, rel), 'utf8');

const userCell = read('../cells/UserCell.tsx');
const composer = read('../TimelineComposer.tsx');
const bridge = read('../../../app/NeoxRuntimeBridge.tsx');

describe('编辑并重发落在底部输入框', () => {
  it('就地小编辑器已经删除', () => {
    expect(existsSync(resolve(HERE, '../cells/MessageInlineEditor.tsx'))).toBe(false);
    expect(userCell).not.toMatch(/MessageInlineEditor/);
  });

  it('编辑按钮把文字送到输入框 (neox:composer:edit-message)', () => {
    expect(userCell).toMatch(/neox:composer:edit-message/);
    /* 带上 entryId —— 少了它输入框就不知道在改哪一条, 只能退化成"再问一遍" */
    expect(userCell).toMatch(/entryId: message\.id/);
  });

  it('输入框在编辑态发送时走真正的重跑管线, 不是普通追加', () => {
    expect(composer).toMatch(/neox:composer:edit-message/);
    expect(composer).toMatch(/neox:message:edit-resend/);
    /* 编辑态的分支必须在 submit 里, 且早于普通发送 */
    const submitAt = composer.indexOf('const submit = useCallback');
    const editAt = composer.indexOf('if (editingEntry) {', submitAt);
    expect(submitAt).toBeGreaterThan(-1);
    expect(editAt).toBeGreaterThan(submitAt);
  });

  it('三层一起裁的那条管线还在 (界面 / SQLite / 模型记忆)', () => {
    expect(bridge).toMatch(/neox:message:edit-resend/);
    expect(bridge).toMatch(/truncateFromUserMessage/);
    expect(bridge).toMatch(/truncateTimelineFrom/);
  });

  it('不许再有"没改动就当取消"这条判据', () => {
    /* 老实现: next === initialText.trim() → onCancel()。按了重发却什么都不发生。 */
    expect(composer).not.toMatch(/=== initialText/);
    expect(userCell).not.toMatch(/=== initialText/);
  });

  it('编辑提示是药丸不是横幅, 且不带竖彩条', () => {
    expect(composer).toMatch(/atl-composer__pill--edit/);
    expect(composer).not.toMatch(/atl-composer__editing/);
    const css = read('../agent-timeline.css');
    expect(css).not.toMatch(/\.atl-composer__editing\b/);
    /* 横幅那条 border-left 彩条不许回来 */
    const block = css.slice(css.indexOf('.atl-composer__pill--edit'), css.indexOf('.atl-composer__pill--edit') + 400);
    expect(block).not.toMatch(/border-left/);
  });

  it('药丸紧贴输入框上方 —— 跟错误药丸同一个位置, 不在框里面', () => {
    const pillAt = composer.indexOf('atl-composer__pill--edit');
    const boxAt = composer.indexOf('atl-composer__boxwrap');
    expect(pillAt).toBeGreaterThan(-1);
    expect(pillAt).toBeLessThan(boxAt);   /* 在 boxwrap 之前 = 框外框上 */
  });

  it('编辑态要能取消, 且换会话自动退出编辑态', () => {
    expect(composer).toMatch(/cancelEditing/);
    /* entryId 属于某个会话, 换会话还留着就指向一条不存在的消息 */
    const sw = composer.slice(composer.indexOf('const switchKey ='), composer.indexOf('}, [switchKey, flat]);'));
    expect(sw).toMatch(/setEditingEntry\(null\);/);
  });
});
