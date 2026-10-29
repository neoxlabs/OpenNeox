import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const composer = readFileSync(
  resolve(HERE, '../modules/agent-timeline/TimelineComposer.tsx'),
  'utf8',
);

/** 只取那个自动聚焦 effect 的正文, 避免把文件里另外 8 处 focus() 算进来 */
function autofocusEffect(): string {
  const start = composer.indexOf('const textareaRef = useRef<HTMLTextAreaElement | null>(null);');
  expect(start).toBeGreaterThan(-1);
  const end = composer.indexOf('}, [activeSession?.id]);', start);
  expect(end).toBeGreaterThan(start);
  return composer.slice(start, end);
}

export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * 去掉注释后的 effect 正文。
 *
 *   闸断言的必须是**代码**: 上一版直接扫全文, 结果被文件里那句
 *   "也别用 offsetParent === null 判可见" 的注释判红 —— 注释里写了什么
 *   跟运行时行为无关, 让它参与判定就是在制造假红 (反过来也能制造假绿)。
 */
function autofocusCode(): string {
  return stripComments(autofocusEffect());
}

describe('输入框自动聚焦', () => {
  it('聚焦挂在 activeSession?.id 上 —— 切会话也要跟着走, 不能只在挂载时聚焦一次', () => {
    expect(composer).toMatch(/\}, \[activeSession\?\.id\]\);/);
  });

  it('别人正在输入时必须让开 (INPUT / TEXTAREA / SELECT / contentEditable)', () => {
    const body = autofocusCode();
    expect(body).toMatch(/'INPUT'/);
    expect(body).toMatch(/'TEXTAREA'/);
    expect(body).toMatch(/isContentEditable/);
    expect(body).toMatch(/if \(editable\) return;/);
  });

  function overlayCheckCode(): string {
    const start = composer.indexOf('function isBlockingOverlayOpen()');
    expect(start).toBeGreaterThan(-1);
    const end = composer.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);
    return stripComments(composer.slice(start, end));
  }

  it('弹窗让开的判据是**真的可见**, 不是 DOM 里存在', () => {
    /* effect 里只要挡一下就行, 怎么判是 helper 的事 */
    expect(autofocusCode()).toMatch(/if \(isBlockingOverlayOpen\(\)\) return;/);
    const body = overlayCheckCode();
    expect(body).toMatch(/role="dialog"/);
    expect(body).toMatch(/getBoundingClientRect/);
    expect(body).toMatch(/visibility !== 'hidden'/);
    expect(body).toMatch(/display !== 'none'/);
    expect(body).toMatch(/opacity\) > 0/);
  });

  it('不许拿 offsetParent 判弹窗可见 —— 它们是 fixed, offsetParent 恒为 null', () => {
    /* 只禁**实际用法**; 文件里那句"别用 offsetParent"的注释不该被算进来 */
    expect(autofocusCode()).not.toMatch(/offsetParent\s*(===|!==|\?)/);
  });

  it('聚焦不许带滚动 —— preventScroll, 否则会把 timeline 拽走', () => {
    expect(autofocusCode()).toMatch(/preventScroll:\s*true/);
  });

  it('抢不到焦点不能抛 —— 包了 try/catch', () => {
    expect(autofocusCode()).toMatch(/try \{[^}]*\.focus\(/);
  });
});

describe('空态文案', () => {
  const empty = stripComments(readFileSync(
    resolve(HERE, '../modules/agent-timeline/CodeEmptySuggestions.tsx'),
    'utf8',
  ));
  const timeline = stripComments(readFileSync(
    resolve(HERE, '../modules/agent-timeline/AgentTimelineView.tsx'),
    'utf8',
  ));

  it('"怎么用"只由 placeholder 说一次, 空态副标题不重复', () => {
    expect(timeline).toMatch(/技能、@ 引用上下文/);      /* placeholder 仍在 */
    expect(empty).not.toMatch(/描述任务/);               /* 空态不再复述 */
  });

  it('没有项目时不渲染这行 —— 一行废话不如没有', () => {
    expect(empty).toMatch(/\{projectName && \(/);
  });
});

describe('新建会话一定新建', () => {
  const bridge = stripComments(readFileSync(
    resolve(HERE, '../app/NeoxRuntimeBridge.tsx'),
    'utf8',
  ));
  const composerCode = stripComments(composer);

  it('没有"空会话就复用"的分支', () => {
    expect(bridge).not.toMatch(/shouldReuseBlankSession/);
  });

  it('composer 仍接得住聚焦事件 (其它链路还在用)', () => {
    expect(composerCode).toMatch(/addEventListener\('neox:composer-focus'/);
    expect(composerCode).toMatch(/removeEventListener\('neox:composer-focus'/);
  });
});
