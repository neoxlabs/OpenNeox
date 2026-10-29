/**
 * Neox Editor Engine 初始化
 *
 * 业务侧只 import Neox Editor Engine；底层编辑器由这里统一适配。
 * Vite alias 会把底层 editor package 解析到本地 fork，再传给 loader.config。
 */

import { loader } from '@monaco-editor/react';
import * as editorEngine from 'monaco-editor';
import 'monaco-editor/esm/vs/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution';
import './themeBridge.css';

// ---- Web Workers ----
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// 使用 Neox 已经 import 好的本地引擎实例，不再走 CDN
loader.config({ monaco: editorEngine });
