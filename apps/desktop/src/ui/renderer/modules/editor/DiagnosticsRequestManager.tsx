/**
 * DiagnosticsRequestManager — 响应 main 的 editor:diagnostics-request,
 * 用 Monaco getModelMarkers 回报当前 IDE 诊断.
 */

import { useEffect } from 'react';
import './engine/setup'; /* 确保 Monaco workers / loader 已初始化 */
import * as monaco from 'monaco-editor';

type Severity = 'error' | 'warning' | 'info' | 'hint';

function mapSeverity(n: monaco.MarkerSeverity): Severity {
  if (n === monaco.MarkerSeverity.Error) return 'error';
  if (n === monaco.MarkerSeverity.Warning) return 'warning';
  if (n === monaco.MarkerSeverity.Info) return 'info';
  return 'hint';
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function pathMatches(markerPath: string, filter: string): boolean {
  const a = normalizePath(markerPath);
  const b = normalizePath(filter);
  if (a === b) return true;
  if (a.endsWith('/' + b) || b.endsWith('/' + a)) return true;
  const base = b.split('/').pop();
  return !!base && a.endsWith('/' + base);
}

export function DiagnosticsRequestManager(): null {
  useEffect(() => {
    const api = (window as any).neox;
    if (typeof api?.onDiagnosticsRequest !== 'function') return;

    const unsubscribe = api.onDiagnosticsRequest((data: {
      requestId: string;
      paths?: string[];
      limit?: number;
    }) => {
      try {
        const markers = monaco.editor.getModelMarkers({});
        const filters = (data.paths || []).filter((p) => typeof p === 'string' && p.trim());
        let items = markers.map((m) => {
          const model = monaco.editor.getModel(m.resource);
          const path = m.resource?.fsPath || m.resource?.path || model?.uri?.fsPath || String(m.resource);
          return {
            path: normalizePath(path),
            line: m.startLineNumber,
            column: m.startColumn,
            endLine: m.endLineNumber,
            endColumn: m.endColumn,
            severity: mapSeverity(m.severity),
            message: m.message,
            source: m.source || undefined,
            code: m.code != null ? String(m.code) : undefined,
          };
        });

        if (filters.length > 0) {
          items = items.filter((it) => filters.some((f) => pathMatches(it.path, f)));
        }

        /* 错误优先 */
        const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };
        items.sort((a, b) => (rank[a.severity] - rank[b.severity]) || a.path.localeCompare(b.path) || a.line - b.line);

        const limit = typeof data.limit === 'number' && data.limit > 0 ? data.limit : 80;
        void api.diagnosticsRequestComplete?.(data.requestId, {
          diagnostics: items.slice(0, limit),
        });
      } catch (err: any) {
        void api.diagnosticsRequestComplete?.(data.requestId, {
          diagnostics: [],
          error: err?.message || String(err),
        });
      }
    });

    return () => {
      try { unsubscribe?.(); } catch { /* */ }
    };
  }, []);

  return null;
}

export default DiagnosticsRequestManager;
