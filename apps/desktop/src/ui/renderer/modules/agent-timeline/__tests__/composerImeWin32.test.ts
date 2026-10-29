/* Windows 输入法: 打几次中文之后候选框不再弹出、只能打英文。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const composer = readFileSync(join(__dirname, '..', 'TimelineComposer.tsx'), 'utf8');
const mainWin = readFileSync(
  join(__dirname, '../../../../electron/services/mainWindowFactory.ts'),
  'utf8',
);

const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
    .replace(/^\s*\/\/.*$/gm, '');

const COMPOSER = code(composer);
const MAIN = code(mainWin);

describe('Windows 输入法组字不被拆掉', () => {
  it('输入框不是受控 value=, 组字中 React 不会回写 .value', () => {
    const ta = COMPOSER.indexOf('className={`atl-composer__input$');
    expect(ta).toBeGreaterThan(-1);
    const end = COMPOSER.indexOf('/>', ta);
    const tag = COMPOSER.slice(ta, end);
    expect(tag, '受控 value= 每次 commit 都会拆 TSF').not.toMatch(/\bvalue=\{value\}/);
    expect(COMPOSER).toMatch(/composingRef\.current\) return/);
    expect(COMPOSER).toMatch(/el\.value !== value\) el\.value = value/);
  });

  it('组字中的按键不 preventDefault (候选框方向键 / Process)', () => {
    expect(COMPOSER).toMatch(/isComposing \|\| e\.key === 'Process'\) return/);
  });

  it('组字期间只记 DOM 值, 不 setState / 不量高 / 不跑触发器', () => {
    const at = COMPOSER.indexOf('const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>)');
    expect(at, '找不到输入框的 onChange —— 断言写错了或它被改名').toBeGreaterThan(0);
    const body = COMPOSER.slice(at, COMPOSER.indexOf('\n  };', at));
    /* 组字早退要先于 setValue / adjust / updateTriggers 执行：这三者都会触发重绘，
       重绘会打断 IME 正在进行的组字过程 */
    const guard = body.indexOf('if (composingRef.current) return;');
    expect(guard, '组字早退不在 onChange 里 = 每敲一个字都重绘, TSF 组字会被拆').toBeGreaterThan(0);
    for (const call of ['setValue(next)', 'adjust()', 'updateTriggers(']) {
      expect(body.indexOf(call), `${call} 排在组字早退之前`).toBeGreaterThan(guard);
    }
    /* DOM 里的最新值仍要记下来, 否则组字结束时拿不到用户已经打出来的字 */
    expect(body).toMatch(/valueRef\.current = next/);
  });

  it('主窗 focus 重绑 IME 时跳过正在组字、跳过已经 focus 的 webContents', () => {
    expect(MAIN).toMatch(/if \(imeComposing\) return/);
    expect(MAIN).toMatch(/webContents\.isFocused\(\)\) return/);
    expect(MAIN).toMatch(/input\.isComposing/);
  });
});
