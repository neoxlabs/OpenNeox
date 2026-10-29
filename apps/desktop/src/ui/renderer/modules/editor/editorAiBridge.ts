import type { editor as MonacoEditor } from 'monaco-editor';
import { ensureMainVisible } from '../../state/panelLayoutStore';

export interface EditorCodeRef {
  /** 代码原文 */
  text: string;
  /** 附件名: `file.ts:12-30` */
  name: string;
  path?: string;
  language?: string;
  lineRange?: { start: number; end: number };
}

export interface ComposerAttachCodeDetail {
  code: EditorCodeRef;
  /** 有 prompt 且 send=true: 挂上附件后直接发出这句; send 不为 true: 放进输入框等人按回车 */
  prompt?: string;
  send?: boolean;
  /** 输入框认领后置 true, 发起方据此停止重试 */
  handled?: boolean;
}

export type EditorAiIntent = 'add' | 'explain' | 'fix' | 'optimize' | 'tests';

/** 整份文件不超过这么多行时, 没选中也直接拿整份; 再大就只拿光标所在的那一段 */
const WHOLE_FILE_MAX_LINES = 400;
const AROUND_CURSOR_LINES = 30;

function baseName(p: string | undefined): string {
  if (!p) return 'untitled';
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * 从编辑器取一段代码: 有选区取选区; 没选区时小文件取整份, 大文件取光标上下各 30 行。
 * 「解释 / 修复这一段」在没选中时仍然该有东西可问 —— 空手而归比多给点上下文更糟。
 */
export function collectCode(editor: MonacoEditor.IStandaloneCodeEditor, path?: string): EditorCodeRef | null {
  const model = editor.getModel();
  if (!model) return null;
  const language = model.getLanguageId();
  const name = baseName(path ?? model.uri.path);
  const sel = editor.getSelection();
  if (sel && !sel.isEmpty()) {
    const text = model.getValueInRange(sel);
    if (!text.trim()) return null;
    /* 按行选 (Shift+↓) 时选区落在下一行第 1 列, 那一行其实一个字都没选 */
    const end = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
    return { text, name: `${name}:${sel.startLineNumber}-${end}`, path, language, lineRange: { start: sel.startLineNumber, end } };
  }
  const total = model.getLineCount();
  if (total <= WHOLE_FILE_MAX_LINES) {
    const text = model.getValue();
    if (!text.trim()) return null;
    return { text, name, path, language, lineRange: { start: 1, end: total } };
  }
  const line = editor.getPosition()?.lineNumber ?? 1;
  const start = Math.max(1, line - AROUND_CURSOR_LINES);
  const end = Math.min(total, line + AROUND_CURSOR_LINES);
  const text = model.getValueInRange({ startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: model.getLineMaxColumn(end) });
  return { text, name: `${name}:${start}-${end}`, path, language, lineRange: { start, end } };
}

/** 各意图发给模型的那句话 —— 只说要什么, 代码本身在附件里 */
export function intentPrompt(intent: Exclude<EditorAiIntent, 'add'>, zh: boolean, extra?: string): string {
  const map: Record<Exclude<EditorAiIntent, 'add'>, [string, string]> = {
    explain: ['解释一下这段代码在做什么。', 'Explain what this code does.'],
    fix: ['这段代码有什么问题？直接改好。', 'What is wrong with this code? Fix it.'],
    optimize: ['优化这段代码（可读性和性能），直接改。', 'Improve this code (readability and performance) and apply the change.'],
    tests: ['给这段代码写单元测试。', 'Write unit tests for this code.'],
  };
  const base = zh ? map[intent][0] : map[intent][1];
  return extra ? `${base}\n${extra}` : base;
}

/** 报错快速修复带过去的上下文: 报错行上下各这么多行 */
const DIAGNOSTIC_CONTEXT_LINES = 15;

export interface DiagnosticRef {
  message: string;
  startLineNumber: number;
  endLineNumber: number;
}

/** 报错那几行 + 上下文, 行号跟编辑器一致 (附件名带行号, 模型据此定位) */
export function collectDiagnosticCode(editor: MonacoEditor.IStandaloneCodeEditor, diag: DiagnosticRef, path?: string): EditorCodeRef | null {
  const model = editor.getModel();
  if (!model) return null;
  const start = Math.max(1, diag.startLineNumber - DIAGNOSTIC_CONTEXT_LINES);
  const end = Math.min(model.getLineCount(), diag.endLineNumber + DIAGNOSTIC_CONTEXT_LINES);
  const text = model.getValueInRange({ startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: model.getLineMaxColumn(end) });
  return { text, name: `${baseName(path ?? model.uri.path)}:${start}-${end}`, path, language: model.getLanguageId(), lineRange: { start, end } };
}

export function diagnosticPrompt(diag: DiagnosticRef, zh: boolean): string {
  return zh
    ? `第 ${diag.startLineNumber} 行报错：${diag.message}\n修好它。`
    : `Line ${diag.startLineNumber} reports: ${diag.message}\nFix it.`;
}

/** 快速修复里「用 Neox 修复」调用的全局命令 id */
const FIX_DIAGNOSTIC_COMMAND = 'neox.ai.fixDiagnostic';

/* 命令是全局的, 但修复要落到「报错所在的那个编辑器」上 —— 按模型 uri 找回编辑器。
 * 不能用 editor.addAction 接: standalone Monaco 给 action 的命令 id 加了编辑器实例前缀
 * (`vs.editor.ICodeEditor:1:xxx`), 代码操作里写的裸 id 永远找不到它, 点了没反应。 */
type FixHandler = { editor: MonacoEditor.IStandaloneCodeEditor; run: (diag: DiagnosticRef) => void };
const fixHandlers = new Set<FixHandler>();

/** 编辑器接住「用 Neox 修复」; 编辑器销毁时自动摘掉 */
export function onFixDiagnostic(editor: MonacoEditor.IStandaloneCodeEditor, run: (diag: DiagnosticRef) => void): void {
  const h: FixHandler = { editor, run };
  fixHandlers.add(h);
  editor.onDidDispose(() => fixHandlers.delete(h));
}

let quickFixRegistered = false;
/**
 * 所有语言的报错/警告都挂一条「用 Neox 修复」。全局只注册一次 (provider 是按语言注册在 monaco 全局上的,
 * 每个编辑器实例再注册一遍会在灯泡菜单里出现 N 条)。
 */
export function registerAiQuickFix(monaco: typeof import('monaco-editor'), zh: boolean): void {
  if (quickFixRegistered) return;
  quickFixRegistered = true;
  monaco.editor.registerCommand(FIX_DIAGNOSTIC_COMMAND, (_accessor, diag: DiagnosticRef, uri: string) => {
    const matches = [...fixHandlers].filter((h) => h.editor.getModel()?.uri.toString() === uri);
    const target = matches.find((h) => h.editor.hasTextFocus()) ?? matches[0];
    target?.run(diag);
  });
  monaco.languages.registerCodeActionProvider('*', {
    provideCodeActions(model, _range, context) {
      const markers = context.markers
        .filter((m) => m.severity >= monaco.MarkerSeverity.Warning)
        .slice(0, 2);
      if (markers.length === 0) return { actions: [], dispose: () => {} };
      const actions = markers.map((m) => {
        const short = m.message.length > 48 ? `${m.message.slice(0, 48)}…` : m.message;
        const diag: DiagnosticRef = { message: m.message, startLineNumber: m.startLineNumber, endLineNumber: m.endLineNumber };
        return {
          title: zh ? `用 Neox 修复：${short}` : `Fix with Neox: ${short}`,
          kind: 'quickfix',
          diagnostics: [m],
          command: { id: FIX_DIAGNOSTIC_COMMAND, title: zh ? '用 Neox 修复' : 'Fix with Neox', arguments: [diag, model.uri.toString()] },
        };
      });
      return { actions, dispose: () => {} };
    },
  });
}

/**
 * 把代码挂到输入框 (可选直接发; 有 prompt 但不发时, 那句话放进输入框等人按回车)。
 * 返回是否有输入框认领 —— 没有就说明当前界面上没有对话输入框 (例如设置页盖着)。
 * timeoutMs: 输入框可能还没挂上 (刚切会话 / 刚关设置页 / 刚切项目) —— 最多等这么久。
 */
export function sendCodeToComposer(
  code: EditorCodeRef,
  opts: { prompt?: string; send?: boolean } = {},
  timeoutMs = 500,
): Promise<boolean> {
  /* 叠放版面下编辑器和输入框不同屏 —— 挂到一个看不见的输入框上等于没发生, 先把对话切出来 */
  ensureMainVisible();
  const started = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      const detail: ComposerAttachCodeDetail = { code, prompt: opts.prompt, send: opts.send };
      window.dispatchEvent(new CustomEvent('neox:composer-attach-code', { detail }));
      if (detail.handled) { resolve(true); return; }
      if (Date.now() - started < timeoutMs) requestAnimationFrame(attempt);
      else resolve(false);
    };
    attempt();
  });
}
