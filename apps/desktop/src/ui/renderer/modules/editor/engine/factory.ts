/**
 * NeoX Editor Engine factory
 *
 * Product UI should create editors through this module instead of calling the
 * low-level editor package directly. The concrete runtime is our local NeoX
 * editor engine (currently resolved by Vite alias), and all IDE / Surface / tool
 * diffs receive the same options, gutter semantics and theme behavior here.
 */

const MONACO_BENIGN_DIFF_REJECTION = 'no diff result available';
let monacoRejectionFilterInstalled = false;
function installMonacoDiffRejectionFilter(): void {
  if (monacoRejectionFilterInstalled) return;
  if (typeof window === 'undefined') return;
  monacoRejectionFilterInstalled = true;
  const isBenign = (msg: unknown): boolean =>
    typeof msg === 'string' && msg.includes(MONACO_BENIGN_DIFF_REJECTION);

  window.addEventListener('unhandledrejection', (event) => {
    const reason: any = event.reason;
    const message = typeof reason === 'string' ? reason : reason?.message;
    if (isBenign(message)) {
      /* diff 被取消是预期路径, 不该以 page error 的形式打扰用户和诊断日志 */
      event.preventDefault();
    }
  });

  window.addEventListener('error', (event) => {
    if (isBenign(event.message) || isBenign((event.error as any)?.message)) {
      event.preventDefault();
    }
  });
}

import { defineNeoxEditorTheme, resolveDocumentIsDark } from './theme';
import { getNeoxCodeEditorOptions, getNeoxDiffEditorOptions, type NeoxEditorOptionsParams } from './options';

export interface NeoxEditorCreateParams extends NeoxEditorOptionsParams {
  value?: string;
  language?: string;
  isDark?: boolean;
  /** false = 不写入 Monaco 全局 theme (无头 / 临时 Diff 用)。默认 true。
   *  Monaco setTheme 是进程级的; 无头 refine 若误切 neox-light, 已开的暗色 Surface
   *  会变成「标识符消失、关键词还在」—— 只有新文件常踩, 点「本轮改动」重挂才好。 */
  applyTheme?: boolean;
  extraOptions?: Record<string, any>;
}

export interface NeoxDiffEditorCreateParams extends NeoxEditorOptionsParams {
  original: string;
  modified: string;
  language?: string;
  isDark?: boolean;
  /** 见 NeoxEditorCreateParams.applyTheme */
  applyTheme?: boolean;
  extraOptions?: Record<string, any>;
}

/* 导出仅为可测 —— 这是"无头 DiffEditor 掀翻全局主题"那个 bug 的唯一闸门,
 * 必须有回归保护 (见 __tests__/factory.theme.test.ts)。 */
export function resolveThemeOption(editorEngine: any, params: { isDark?: boolean; applyTheme?: boolean }): Record<string, string> {
  if (params.applyTheme === false) return {};
  const isDark = params.isDark ?? resolveDocumentIsDark();
  return { theme: defineNeoxEditorTheme(editorEngine, isDark) };
}

export function createNeoxCodeEditor(editorEngine: any, el: HTMLElement, params: NeoxEditorCreateParams = {}) {
  /* 显式标成 Record —— getNeoxCodeEditorOptions 返回的就是 Record<string, any>
   * (一袋 Monaco option), 但展开一个"只有索引签名"的类型时 TS 不会把索引签名带进
   * 对象字面量的推断结果, 于是下面读 options.fontFamily/fontSize/lineHeight 全报
   * TS2339 —— 运行时那三个字段是实打实有值的 (options.ts:62-66), 丢的只是类型。 */
  const options: Record<string, any> = {
    ...getNeoxCodeEditorOptions(params),
    value: params.value ?? '',
    language: params.language ?? 'plaintext',
    ...resolveThemeOption(editorEngine, params),
    ...(params.extraOptions ?? null),
  };
  const ed = editorEngine.editor.create(el, options);
  /* HMR / 旧实例偶发不吃 create 时的 fontFamily; 再强制一次, 保证 Cascadia 生效 */
  try {
    ed.updateOptions({
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      lineHeight: options.lineHeight,
      fontLigatures: false,
      fontWeight: '400',
    });
  } catch { /* noop */ }
  return ed;
}

export function createNeoxDiffEditor(editorEngine: any, el: HTMLElement, params: NeoxDiffEditorCreateParams) {
  /* 第一次真正用到 diff editor 时才装过滤器 —— 没开过 diff 的会话不必挂这个监听 */
  installMonacoDiffRejectionFilter();
  const language = params.language ?? 'plaintext';
  const originalModel = editorEngine.editor.createModel(params.original, language);
  const modifiedModel = editorEngine.editor.createModel(params.modified, language);
  const options = {
    ...getNeoxDiffEditorOptions(params),
    ...resolveThemeOption(editorEngine, params),
    ...(params.extraOptions ?? null),
  };
  const diffEditor = editorEngine.editor.createDiffEditor(el, options);
  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  try {
    const fontOpts = {
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      lineHeight: options.lineHeight,
      fontLigatures: false,
      fontWeight: '400',
    };
    diffEditor.getOriginalEditor?.()?.updateOptions?.(fontOpts);
    diffEditor.getModifiedEditor?.()?.updateOptions?.(fontOpts);
  } catch { /* noop */ }
  diffEditor.onDidDispose(() => {
    try { if (!originalModel.isDisposed()) originalModel.dispose(); } catch { /* */ }
    try { if (!modifiedModel.isDisposed()) modifiedModel.dispose(); } catch { /* */ }
  });
  return diffEditor;
}

export function createNeoxTextModel(editorEngine: any, value: string, language = 'plaintext') {
  return editorEngine.editor.createModel(value, language);
}
