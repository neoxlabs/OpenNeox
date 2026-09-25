/**
 * computer use 的模型侧工具 —— **只有两个**。
 *
 * 为什么只有两个: 浏览器那边的教训。50 多个单步工具握在模型手里, 它就会一步一调,
 * 每步付一次模型往返。收敛成"感知 + 脚本"之后, 同一个任务从 21 次调用降到 4 次。
 * OS 这边一开始就按收敛后的形态做, 不重走一遍弯路。
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import {
  createContextualResult,
  type ToolResult,
} from '@neoxlabs/kernel/core/types/toolResult.js';
import { runComputerScript, computerSnapshot } from './computerRun.js';
import { getOsBridge } from './osBridgeClient.js';
import { appIconPath } from './appIcon.js';
import { readFileSync } from 'node:fs';
import { buildImageToolResult, compressImageDataUrlIfNeeded } from '../../tools/image/imageProcessor.js';

function shotlessPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const p = payload as Record<string, unknown>;
  if (typeof p.screenshot === 'string') {
    const { screenshot: _s, ...rest } = p;
    return rest;
  }
  const screen = p.screen;
  if (screen && typeof screen === 'object' && typeof (screen as { screenshot?: unknown }).screenshot === 'string') {
    const { screenshot: _s, ...restScreen } = screen as Record<string, unknown>;
    return { ...p, screen: restScreen };
  }
  return payload;
}

function shotCaption(payload: unknown): string {
  const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const title = typeof p.windowTitle === 'string' && p.windowTitle ? p.windowTitle : String(p.app ?? '窗口');
  const n = Array.isArray(p.actionable) ? p.actionable.length : 0;
  const digest = typeof p.digest === 'string' && p.digest ? ` ${p.digest.slice(0, 240)}` : '';
  const note = typeof p.note === 'string' && p.note ? ` ${p.note.slice(0, 200)}` : '';
  return `${title} 截图 axBlind=${p.axBlind === true} 可点=${n}.${digest}${note}`
    + ' 看下面这张图用 click_at (dx/dy 为窗口内 0~1)。不要把这段文字当成图片数据, 不要 read 截图路径, 不要自己写 OCR/shell 去抠界面。';
}

/** axBlind 截图: UI 卡片走路径, 模型必须看到像素 (click_at 靠眼睛)。 */
async function computerLlmContent(payload: unknown, shotPath?: string): Promise<string> {
  const json = JSON.stringify(shotlessPayload(payload));
  if (!shotPath) return json;
  try {
    const buf = readFileSync(shotPath);
    const mime = shotPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const funneled = await compressImageDataUrlIfNeeded(`data:${mime};base64,${buf.toString('base64')}`);
    let mediaType = mime;
    let base64 = buf.toString('base64');
    const fm = funneled.url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
    if (fm) {
      mediaType = fm[1];
      base64 = fm[2];
    }
    return buildImageToolResult([{
      base64,
      mediaType,
      label: shotCaption(payload),
    }]);
  } catch {
    return json;
  }
}

async function withComputerUiMeta(input: {
  tool: string;
  /** 'run' = 执行了一串动作 / 'snapshot' = 只看了一眼。渲染层据此分流, 不按工具名猜。 */
  kind: 'run' | 'snapshot';
  payload: unknown;
  ok: boolean;
  summary: string;
  ui: Record<string, unknown> & { app?: string; screenshot?: string };
}): Promise<ToolResult> {
  /* 路径而不是 base64 —— 见 appIcon.ts 顶部那条 12000 字符截断的教训 */
  const iconPath = input.ui.app ? await appIconPath(input.ui.app) : undefined;
  const shotPath = typeof input.ui.screenshot === 'string' ? input.ui.screenshot : undefined;
  return createContextualResult(
    input.tool,
    input.ok ? 'success' : 'error',
    input.summary,
    await computerLlmContent(input.payload, shotPath),
    {
      metadata: { computer: { kind: input.kind, ...input.ui, iconPath } },
      precondition: !input.ok,
    },
  );
}

export const computerSnapshotTool: Tool = {
  name: 'computer_snapshot',
  description:
    'Look at a native app: returns NUMBERED actionable elements (id, role, label) plus a text digest. '
    + 'Use the numbers in computer_run — never raw pixel coordinates, and never a memorized per-app path. '
    + 'Discover the UI each time: snapshot → act → snapshot. Every snapshot and every computer_run '
    + 'reply includes a window screenshot — look at it when a popup is on screen. When a popup/dialog is open, snapshot is that '
    + 'dialog (see `note` / `windowTitle` / `windowClass`), not the window behind it; close it then snapshot '
    + 'again for the main UI. '
    + 'Call this ONCE before writing a script, not between every action: perception costs 100ms-3s '
    + 'depending on the app, and every extra call is also a full model round-trip (~4s). '
    + 'If `axBlind` is true there is no usable element tree (custom-drawn UI, or a window that hangs '
    + 'accessibility — e.g. some Java modal dialogs, WPS). You then get a `screenshot` of the window as an '
    + 'IMAGE in the next message: LOOK at that image and drive with computer_run `click_at` (dx/dy are a '
    + 'RATIO inside the window, 0,0 = top-left, 1,1 = bottom-right). Do NOT Read the screenshot file path, '
    + 'do NOT write OCR/PowerShell/capture scripts, do NOT invent element ids, and do NOT reuse old click '
    + 'positions. Java/Swing apps use Java Access Bridge for numbered elements when the tree is available; '
    + 'if the tree is empty, use the screenshot. Do not switch to an app-specific API/MCP. '
    + 'axBlind: one snapshot, then ONE long computer_run (8–20 click_at/key/type steps). The run reply '
    + 'already has a new screenshot — do not snapshot again until that script finished. Twenty short '
    + 'computer_run calls ≈ 10 minutes and the result will look unfinished. '
    + 'NOTE for Electron/Chromium apps (QQ, VS Code, Slack…): after the app switches views, the OLD '
    + 'view\'s nodes linger in the tree for a while, so `digest` can show BOTH screens at once. '
    + 'To decide which screen you are on, assert on a specific label rather than reading the digest.',
  group: 'read',
  parallelSafety: 'safe',
  isReadOnly: true,
  parameters: {
    type: 'object',
    properties: {
      app: {
        type: 'string',
        description: 'App name or window title. ALWAYS pass it: while the user is chatting with you the '
          + 'frontmost app is Neox itself, which is off limits, so omitting it just gets refused. '
          + 'Product names are fine (IntelliJ IDEA, Android Studio). On Windows office suites '
          + '(WPS/Word/PPT sharing wps.exe) pass the DOCUMENT WINDOW TITLE (e.g. 「演示文稿1 - WPS 2019」). '
          + '「WPS 演示」/ wpp also resolve to the presentation window. '
          + 'Do not pass the launcher title 「WPS - WPS 2019」 or 「WPS 2019」, and do not retarget explorer/Documents '
          + 'because a save dialog is open — stay on the WPS window.',
      },
    },
  },
  function: async (args: any) => {
    const snap = await computerSnapshot(args?.app) as any;
    const failed = snap?.ok === false;
    return JSON.stringify(await withComputerUiMeta({
      tool: 'computer_snapshot',
      kind: 'snapshot',
      payload: snap,
      ok: !failed,
      summary: failed
        ? `看不了 ${snap?.app ?? args?.app ?? '前台应用'}: ${snap?.error ?? snap?.code ?? '未知原因'}`
        : `看了一眼 ${snap?.app ?? ''} · ${snap?.elementCount ?? 0} 个元素`,
      ui: {
        app: snap?.app ?? args?.app,
        screenshot: snap?.screenshot,
        axBlind: snap?.axBlind,
        elementCount: snap?.elementCount,
      },
    }));
  },
};

export const computerRunTool: Tool = {
  name: 'computer_run',
  description:
    'Run a SEQUENCE of UI actions in ONE call. This is the ONLY way to drive apps — '
    + 'there are deliberately no single-action tools, because one action per call costs a full model '
    + 'round-trip (~4s) while an action through the bridge costs 0-130ms. Plan MANY steps ahead. '
    + 'Targets are element numbers from computer_snapshot. '
    + 'CRITICAL: give every numbered-element step that should change the screen an `expectChange` '
    + 'whose watch is "screen" or {"label":"..."} or {"count":"Button"} — an empty watch object is invalid. '
    + 'Skip expectChange on axBlind / click_at / hover / double_click / drag / ratio type/scroll/show_menu / Java (JAB) key|type: those cannot be verified via the '
    + 'element tree (popups hang or lag the accessibility worker) and a 6-8s poll is just wasted time '
    + '(the runtime skips it anyway). Otherwise "clicked but nothing happened" '
    + 'is reported as success and every later step builds on a false premise. '
    + 'Actions prefer OS accessibility actions (macOS AX / Windows UIA patterns: no cursor movement, no focus '
    + 'steal, works while the app is in the background) and fall back to coordinate clicks only when the '
    + 'element has no such action. PLATFORM NOTE: on Windows `set_value` and `press` stay in that safe '
    + 'category, but `type` / `key` / `click_at` need the window in the foreground and DO move the real '
    + 'cursor — prefer set_value for text, and expect the app to come forward. '
    + 'On failure you get the exact step, the reason, and the current screen — earlier steps are NOT re-run. '
    + 'EVERY result (success too) carries `screen`, so do NOT spend another call just to look at the app. '
    + 'axBlind: pack many click_at/key/type steps into ONE script (raise timeoutMs if the pass is long). '
    + 'Do not call computer_run once per click. '
    + 'After opening a picker (emoji, @ mention, combo), wait for the numbered tree (and look at the screenshot). '
    + 'If a big overlay is still open, Escape before Send/Enter so the keys do not go into the picker search box. '
    /* 说在前面, 省得模型试一次被拒再改口 —— 那是一整轮往返 */
    + 'OFF LIMITS (refused by the OS bridge itself, do not try): terminal apps (macOS: Terminal / iTerm / '
    + 'Warp / kitty / Script Editor; Windows: cmd / PowerShell / Windows Terminal / conhost / WSL) — typing '
    + 'into a terminal is running arbitrary commands and '
    + 'bypasses the approval, sandbox and risk checks execute_shell goes through, so use execute_shell; '
    + 'Neox\'s own windows — clicking its approval card would be self-authorization; '
    + 'system authorization / password dialogs (SecurityAgent, Keychain) — those exist so a human '
    + 'clicks them, tell the user instead.',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      app: {
        type: 'string',
        description: 'App name or window title. ALWAYS pass it — the frontmost app is usually Neox itself. '
          + 'On Windows, when several windows share a process (WPS 文字 vs 演示), pass the document window title, not the WPS home/launcher 「WPS 2019」. Stay on that window; do not switch app to explorer/Documents to finish Save As. If the presentation is behind the home window, launch/snapshot that title first so the bridge raises it. Chat/session rows often show up as Text, not Button — they are numbered; click still hits the row center. Small named toolbar Images (图片/文件) are in the tree; click them by number. Unlabeled chevron next to 发送 is 「发送菜单」, not 发送.',
      },
      steps: {
        type: 'array',
        description:
          'Actions in order. Each: {action, target?, text?, key?, expectChange?, optional?, label?}. '
          + 'action: click_at (when the snapshot is axBlind: dx/dy are a 0-1 ratio inside the window, '
          + 'read off THAT screenshot — do not reuse positions from another app or an older shot) | '
          + 'hover (same dx/dy, move the cursor without clicking — ribbons/galleries that open on hover) | '
          + 'double_click (target number, or dx/dy ratio) | '
          + 'drag (dx/dy start and dx2/dy2 end, both 0-1 ratios inside the window) | '
          + 'launch (open/wake an app by name or bundle id and wait for its window — put this '
          + 'FIRST when the app may not be running) | click (AX press, falls back to background click) | press | focus | set_value (write text '
          + 'straight into a field, much faster than typing) | type (keystrokes; on axBlind also dx/dy 0-1 like click_at — clicks that spot then types in the same foreground hold so focus does not drop) | key (named key + modifiers) '
          + '| scroll (target number, or dx/dy 0-1 like click_at to wheel over that spot on the screenshot) | show_menu (right-click: target number, or dx/dy 0-1 on the screenshot; uses the accessibility '
          + 'show-menu action when the element really implements it, otherwise sends a real background '
          + 'right-click — the reply says which via "via") | select_text (select text INSIDE a text element: '
          + 'text = the substring to select, omit it to select all; occurrence = which match when the same '
          + 'text appears several times. Use this instead of cmd+A when you only want part of the field) '
          + '| snapshot. There is NO sleep/wait action on purpose — use expectChange, it polls and '
          + 'continues the moment the screen changes.',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            app: { type: 'string', description: 'launch only: app name (as in /Applications, without .app) or bundle id.' },
            target: { type: 'number', description: 'Element number from computer_snapshot.' },
            text: { type: 'string' },
            key: { type: 'string', description: 'return / tab / escape / insert / arrows / f1-f12 / a-z, or a chord in the key itself: alt+insert / ctrl+s / ctrl+alt+shift+s' },
            modifiers: { type: 'array', items: { type: 'string' }, description: 'cmd / shift / alt / ctrl — optional if the chord is already in key' },
            dx: { type: 'number' },
            dy: { type: 'number' },
            dx2: { type: 'number', description: 'drag only: end x ratio 0-1' },
            dy2: { type: 'number', description: 'drag only: end y ratio 0-1' },
            occurrence: { type: 'number', description: 'select_text only: which match to select, 1-based. Default 1.' },
            expectChange: {
              type: 'object',
              description:
                'What MUST change after this step. Omit on axBlind / click_at / hover / double_click / drag / ratio-scroll / ratio-show_menu / ratio-type / Java key|type. '
                + 'watch MUST be one of: {"label":"..."} (preferred) | {"count":"Button"} | "screen". '
                + 'Empty {} is invalid. Baseline is captured BEFORE the action, then polled. '
                + 'watch: {"label":"..."} (an element with this label appears — PREFER THIS, it is exact) | '
                + '{"count":"AXRow"} (number of elements with this role changes) | "screen" (whole-screen '
                + 'text changed; a fallback for when you do not know what the target screen contains — it '
                + 'samples twice to ignore text that changes on its own, like unread counts and clocks). '
                + 'If the watched target cannot be read even BEFORE the action, the step fails as '
                + '"target not found" — which is a different problem from "the click did nothing".',
              properties: {
                watch: {},
                timeoutMs: { type: 'number', description: 'default 6000' },
              },
            },
            optional: { type: 'boolean', description: 'Keep going if this step fails. Default false.' },
            label: { type: 'string' },
          },
          required: ['action'],
        },
      },
      timeoutMs: { type: 'number', description: 'Whole-script budget. Default 60000.' },
    },
    required: ['steps'],
  },
  function: async (args: any, ctx: any) => {
    const r = await runComputerScript(args, ctx) as any;
    return JSON.stringify(await withComputerUiMeta({
      tool: 'computer_run',
      kind: 'run',
      payload: r,
      ok: r?.ok !== false,
      summary: r?.ok !== false
        ? `${r?.app ?? '电脑'} · ${r?.ranSteps ?? 0}/${r?.totalSteps ?? 0} 步 ${r?.totalMs ?? 0}ms`
        : `${r?.app ?? '电脑'} · 第 ${(r?.failedAt ?? 0) + 1} 步失败`,
      ui: {
        app: r?.app ?? args?.app,
        screenshot: r?.screen?.screenshot,
        /* 每一步的结果 —— 卡片展开后要能看到"哪一步做了、耗了多久、哪一步炸了" */
        steps: Array.isArray(r?.steps)
          ? r.steps.map((s: any) => ({
              action: s?.action, label: s?.label, ok: s?.ok, ms: s?.ms, error: s?.error,
            }))
          : [],
        failedAt: r?.failedAt,
        totalMs: r?.totalMs,
      },
    }));
  },
};

/**
 * 授权探测 —— 给设置页/首次引导用, **不弹系统窗**。
 * 弹窗时机该由 UI 决定, 不该被一次工具调用顺手触发。
 */
export const computerCheckAccessTool: Tool = {
  name: 'computer_check_access',
  description:
    'Check the OS permissions computer use needs (macOS: accessibility + screen recording; Windows: process integrity / UAC). '
    + 'Call this whenever an OS action fails with `not_trusted`, `accessibility_degraded`, or `need_elevation`. '
    + 'On macOS pass `prompt: true` to ASK for permission: it pops the system dialog AND opens System Settings '
    + 'straight to the Accessibility pane, so the user can grant it right there instead of hunting '
    + 'through four levels of menus. Do that rather than telling the user to go find it themselves. '
    + 'On Windows `prompt: true` asks the user to click one UAC prompt so the bridge can drive admin apps. '
    + 'The UAC consent UI itself is always clicked by the human — never by computer use.',
  group: 'read',
  parallelSafety: 'safe',
  /* prompt:true 会弹系统窗 + 打开设置页 —— 那是副作用, 不算只读 */
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'boolean',
        description:
          'macOS: pop the system permission dialog and open Accessibility settings. '
          + 'Windows: show a UAC prompt to elevate the OS bridge so admin apps can be driven. Default false (check only).',
      },
    },
  },
  function: async (args: any) => {
    const bridge = getOsBridge();
    if (args?.prompt) {
      if (process.platform === 'win32') {
        const r = await bridge.elevate() as any;
        return JSON.stringify({
          ...r,
          guidance: r?.ok
            ? (r.alreadyElevated
              ? '桥已经能驱动管理员应用。'
              : '已经弹出 Windows UAC。请用户点「是」。UAC 同意框必须由人点, 不要改用别的办法绕。')
            : '提权没成功。普通应用仍然能控。要控管理员应用必须由用户点一次 UAC「是」。',
        });
      }
      const r = await bridge.request({ op: 'request_access' }) as any;
      return JSON.stringify({
        ...r,
        guidance: '已经把系统授权对话框和「辅助功能」设置页打开了。请用户在那里勾选 Neox。'
          + ' **如果 Neox 那一项看起来已经勾着但仍然不能用**, 让用户把它取消勾选再重新勾上 ——'
          + ' 授权是绑签名的, 应用升级后记录还在但权限已失效, 只勾不取消没有用。',
      });
    }
    const r = await bridge.probe();
    if (process.platform === 'win32') {
      const can = !!r.privilege?.canDriveElevated;
      return JSON.stringify({
        ...r,
        guidance: r.ok
          ? (can
            ? '桥已经能驱动管理员应用。'
            : '普通应用现在就能控。要控管理员应用再调一次 computer_check_access({prompt: true}), 会弹出 Windows UAC, 必须由用户点「是」。UAC 同意框不会被代点。')
          : '桥没有回应 —— 构建没跑或打包漏带, 不是授权问题。',
      });
    }
    return JSON.stringify({
      ...r,
      guidance: r.trusted
        ? undefined
        : '没有辅助功能授权。**别让用户自己去翻设置** —— 再调一次 computer_check_access({prompt: true}),'
          + ' 那会把系统授权对话框和设置页直接弹到他面前。',
    });
  },
};

export const COMPUTER_TOOLS: Tool[] = [computerSnapshotTool, computerRunTool, computerCheckAccessTool];
export const COMPUTER_TOOL_NAMES: string[] = COMPUTER_TOOLS.map((t) => t.name);
