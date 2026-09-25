#!/usr/bin/env node
/**
 * 渲染层不许用原生 window.confirm / alert / prompt。
 *
 *   Electron 把它们渲染成 macOS 系统弹窗 (灰底 + 蓝 OK + Electron 图标),
 *   跟产品设计语言完全脱节, 而且 alert 会阻塞渲染进程。
 *   仓库已有统一替代:
 *
 *     确认  await confirmAsync({ title, message, variant: 'danger' })   components/confirmEvents
 *     输入  await promptAsync({ ... })                                  components/confirmEvents
 *     提示  dispatchHint(msg, 'info' | 'success' | 'warning')           components/notifyEvents
 *     失败  dispatchOpFailed({ op, message })                           components/notifyEvents
 *
 *   例外必须就地写 `neox-allow-native-dialog` 注释并说明理由 —— 目前唯一的合法
 *   例外是桌宠窗口: 它是独立 BrowserWindow, 没挂 ConfirmDialogHost, confirmAsync
 *   在那里会永远 pending。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] ?? 'apps/desktop/src/ui/renderer');
const PATTERN = /\bwindow\.(confirm|alert|prompt)\s*\(/;
const ALLOW = /neox-allow-native-dialog/;
/* 这两个文件本身就是替代品的实现与说明, 里面提到这些名字是正常的 */
const SKIP_FILES = new Set(['confirmEvents.tsx', 'FileDialogs.tsx']);

const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      walk(full);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || SKIP_FILES.has(entry)) continue;

    const lines = readFileSync(full, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      /* 注释里提到这些名字不算违规 —— 说明文字本来就该提 */
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      if (!PATTERN.test(line)) return;
      /* 例外写在本行, 或紧邻其上那整块注释里的任意一行 ——
       * 固定回看 N 行会漏掉多行注释块的开头 (实测踩过) */
      if (ALLOW.test(line)) return;
      let j = i - 1;
      while (j >= 0) {
        const t = lines[j].trim();
        if (t === '') { j--; continue; }
        if (!(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))) break;
        if (ALLOW.test(t)) return;
        j--;
      }
      offenders.push(`${path.relative(process.cwd(), full)}:${i + 1}  ${trimmed.slice(0, 90)}`);
    });
  }
}

walk(ROOT);

if (offenders.length > 0) {
  console.error(`[native-dialogs] ✗ ${offenders.length} 处用了原生弹窗:\n`);
  offenders.forEach(o => console.error('  ' + o));
  console.error(
    '\n改用统一弹窗: confirmAsync / promptAsync (components/confirmEvents),' +
    '\n            dispatchHint / dispatchOpFailed (components/notifyEvents)。' +
    '\n确有必要保留原生的, 在那一行或上一行注释里写 neox-allow-native-dialog 并说明理由。',
  );
  process.exit(1);
}

console.log('[native-dialogs] ✓ 干净 — 渲染层没有原生 window.confirm/alert/prompt');
