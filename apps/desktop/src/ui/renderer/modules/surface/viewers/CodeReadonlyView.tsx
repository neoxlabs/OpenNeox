/* ============================================================
 * CodeReadonlyView — 轻量 readonly 代码视图
 *
 *   给 markdown / doc / 任何"看渲染产物的 viewer" 提供"源码"切换用.
 *   跟 CodeSurfaceViewer 的 SingleCodeView 区别: 不带 diff / decorations / changedLines,
 *   纯 readonly + 语言高亮 + Cmd+F 搜索 (底层编辑器自带 widget).
 *
 *   用法:
 *     <CodeReadonlyView content={text} language="markdown" />
 * ============================================================ */

import React, { useEffect, useRef } from 'react';
import { useNeoxEditorTheme, defineNeoxEditorTheme } from '../../editor/engine/theme';
import { loadNeoxEditorEngine } from '../../editor/engine/runtime';
import { createNeoxCodeEditor } from '../../editor/engine/factory';

interface Props {
  content: string;
  language?: string;
}

export const CodeReadonlyView: React.FC<Props> = ({ content, language = 'markdown' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const editorEngineRef = useRef<any>(null);
  const { isDark, preset: themePreset } = useNeoxEditorTheme();

  /* 挂载: 异步加载 Neox Editor Engine + 创建 readonly editor */
  useEffect(() => {
    let cancelled = false;
    const el = containerRef.current;
    if (!el) return;
    (async () => {
      const editorEngine: any = await loadNeoxEditorEngine();
      if (cancelled) return;
      editorEngineRef.current = editorEngine;
      if (editorRef.current) return;
      const editor = createNeoxCodeEditor(editorEngine, el, {
        wordWrap: 'on',
        minimap: false,
        fontSize: 12,
        readOnly: true,
        value: content,
        language,
        isDark,
      });
      editorRef.current = editor;
    })();
    return () => {
      cancelled = true;
      editorRef.current?.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  /* content 变化 → 更新 model (避免重建 editor) */
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const model = ed.getModel();
    if (model && model.getValue() !== content) {
      model.setValue(content);
    }
  }, [content]);

  /* 主题切换 — Neox 自定义主题, themePreset 在 deps 里, 切预设时重 register + setTheme. */
  useEffect(() => {
    const editorEngine = editorEngineRef.current;
    if (!editorEngine) return;
    editorEngine.editor.setTheme(defineNeoxEditorTheme(editorEngine, isDark));
  }, [isDark, themePreset]);

  return <div ref={containerRef} className="sfc-code-readonly" style={{ width: '100%', height: '100%' }} />;
};

export default CodeReadonlyView;
