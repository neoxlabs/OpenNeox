
import type { Page } from 'playwright-core';
import { moveAgentCursor } from './browserTakeoverController.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import type { AriaNodeOut, BrowserScreenshotResult } from './browserTools.js';

/** 把 Playwright accessibility.snapshot() 的输出做剪枝 + 字段过滤, 喂给 LLM 紧凑表达. */
export function normalizeAriaNode(node: any, depth: number, maxDepth: number, pruneGeneric: boolean): AriaNodeOut | null {
  if (!node) return null;
  const role: string = node.role || 'generic';
  /* 修剪 generic 容器 (但保留有 name 的) — 减少 80% 的噪音节点 */
  const isPrunable = pruneGeneric
    && (role === 'generic' || role === 'none' || role === 'presentation' || role === 'GenericContainer')
    && !node.name
    && !node.value;
  let children: AriaNodeOut[] | undefined;
  if (Array.isArray(node.children) && node.children.length > 0) {
    if (depth >= maxDepth) {
      children = [{ role: `…${node.children.length} more`, name: undefined }];
    } else {
      const filtered = node.children
        .map((c: any) => normalizeAriaNode(c, depth + 1, maxDepth, pruneGeneric))
        .filter((c: AriaNodeOut | null): c is AriaNodeOut => !!c);
      children = filtered.length > 0 ? filtered : undefined;
    }
  }
  /* 可修剪节点且自己也没 children → 整个略过 */
  if (isPrunable && !children) return null;
  /* 可修剪但有有意义的 children → 拍平 (把 children 直接上浮) */
  if (isPrunable && children) {
    if (children.length === 1) return children[0]!;
    return { role: 'group', children };
  }
  const out: AriaNodeOut = { role };
  if (node.name) out.name = node.name;
  if (node.value) out.value = node.value;
  if (typeof node.level === 'number') out.level = node.level;
  if (typeof node.checked !== 'undefined') out.checked = node.checked;
  if (typeof node.selected !== 'undefined') out.selected = node.selected;
  if (typeof node.expanded !== 'undefined') out.expanded = node.expanded;
  if (node.disabled === true) out.disabled = true;
  if (children) out.children = children;
  return out;
}

/* CDP AXNode 转 normalizeAriaNode 期望的 shape (role/name/value/children).
 * CDP 原始格式: { nodeId, role: { value }, name: { value }, value: { value },
 * childIds: string[], properties: [{ name, value: {value} }] }. */
export function cdpAxNodeToSimple(axNode: any, nodesById: Map<string, any>): any {
  if (!axNode) return null;
  const role = axNode.role?.value || 'generic';
  const name = axNode.name?.value;
  const value = axNode.value?.value;
  /* 把 properties 平摊 */
  const props: Record<string, any> = {};
  for (const p of axNode.properties ?? []) {
    if (p?.name && p?.value && 'value' in p.value) props[p.name] = p.value.value;
  }
  const children: any[] = [];
  for (const cid of axNode.childIds ?? []) {
    const child = nodesById.get(cid);
    if (child) {
      const c = cdpAxNodeToSimple(child, nodesById);
      if (c) children.push(c);
    }
  }
  return {
    role,
    name,
    value,
    level: typeof props.level === 'number' ? props.level : undefined,
    checked: props.checked,
    selected: props.selected,
    expanded: props.expanded,
    disabled: props.disabled,
    children,
  };
}

/** Humanlike 鼠标移动 — 贝塞尔曲线 + 随机微抖. 简化版 ghost-cursor 算法.
 *  ghost-cursor 自己跟 Playwright API 不直接兼容 (它针对 puppeteer 设计),
 *  这里自研一个 ~30 行的等价实现, 完整可控. */
export async function humanlikeMoveTo(page: Page, x0: number, y0: number, x1: number, y1: number): Promise<void> {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  /* 距离越远步数越多, 8~24 步 */
  const steps = Math.min(24, Math.max(8, Math.round(dist / 20)));
  /* 贝塞尔控制点: 起点 - 终点连线中点 + 垂直方向微偏移 */
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const perpX = -(y1 - y0);
  const perpY = (x1 - x0);
  const len = Math.hypot(perpX, perpY) || 1;
  const wobble = (Math.random() - 0.5) * Math.min(80, dist * 0.3);
  const ctrlX = mx + (perpX / len) * wobble;
  const ctrlY = my + (perpY / len) * wobble;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    /* 二次贝塞尔: (1-t)²·P0 + 2(1-t)t·C + t²·P1 */
    const x = u * u * x0 + 2 * u * t * ctrlX + t * t * x1;
    const y = u * u * y0 + 2 * u * t * ctrlY + t * t * y1;
    /* 加微抖 */
    const jx = x + (Math.random() - 0.5) * 1.5;
    const jy = y + (Math.random() - 0.5) * 1.5;
    await moveAgentCursor(page, jx, jy);
    await page.mouse.move(jx, jy);
    /* 每步 8-20ms, 总移动时长 ~150-300ms */
    await new Promise(r => setTimeout(r, 8 + Math.random() * 12));
  }
}

/** 惰性 import node 内置 + pixelmatch/pngjs, 让 non-node runtime 也能 import 本文件. */
export async function loadArtifactHelpers() {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const base = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'browser-artifacts');
  return {
    getArtifactPath: async (surfaceId: string, category: string) => {
      const safe = String(surfaceId || 'default').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60);
      return path.join(base, safe || 'default', category);
    },
    ensureDir: async (dir: string) => { await fs.mkdir(dir, { recursive: true }); },
    writeFile: async (p: string, data: Buffer | string) => { await fs.writeFile(p, data); },
    readFile: async (p: string) => { return await fs.readFile(p); },
    readFileText: async (p: string) => { return await fs.readFile(p, 'utf-8'); },
    pathJoin: path.join,
  };
}

/**
 * PNG 视觉 diff. 惰性 import pngjs + pixelmatch (dep 可选, 装了就用).
 * 尺寸不一致直接返 error, 让 agent 知道 baseline 需要重跑.
 */
export async function compareScreenshots(baselineBuf: Buffer, currentBuf: Buffer, threshold: number): Promise<NonNullable<BrowserScreenshotResult['diff']>> {
  try {
    /* @ts-ignore — pngjs / pixelmatch 都是可选 dep, 装了才能做 diff. 类型缺失不阻塞编译. */
    const { PNG } = await import('pngjs' as any);
    /* pixelmatch v6 是 ESM default export, v5 是 CJS named. 兼容两种 */
    /* @ts-ignore */
    const pixelmatchMod: any = await import('pixelmatch' as any).catch(() => null);
    if (!pixelmatchMod) {
      return { ratio: -1, passed: false, diffPixels: -1, error: 'pixelmatch 依赖未装, 无法做视觉 diff (npm i pixelmatch pngjs)' };
    }
    const pixelmatch = pixelmatchMod.default ?? pixelmatchMod;

    const oldPng = PNG.sync.read(baselineBuf);
    const newPng = PNG.sync.read(currentBuf);
    if (oldPng.width !== newPng.width || oldPng.height !== newPng.height) {
      return {
        ratio: 1,
        passed: false,
        diffPixels: -1,
        error: `baseline 尺寸 ${oldPng.width}×${oldPng.height} 与当前 ${newPng.width}×${newPng.height} 不一致, 重跑 baselineMode='save' 更新`,
      };
    }
    const diff = new PNG({ width: oldPng.width, height: oldPng.height });
    const diffPixels: number = pixelmatch(oldPng.data, newPng.data, diff.data, oldPng.width, oldPng.height, {
      threshold: 0.1,
      alpha: 0.3,
      diffColor: [255, 0, 0],
    });
    const total = oldPng.width * oldPng.height;
    const ratio = diffPixels / total;
    return {
      ratio,
      passed: ratio <= threshold,
      diffPixels,
      diffBase64: PNG.sync.write(diff).toString('base64'),
    };
  } catch (err: any) {
    return { ratio: -1, passed: false, diffPixels: -1, error: `diff 失败: ${err?.message || String(err)}` };
  }
}

export const PAPER_SIZES = {
  A4: { width: 8.27, height: 11.69 },
  A3: { width: 11.69, height: 16.54 },
  Letter: { width: 8.5, height: 11 },
  Legal: { width: 8.5, height: 14 },
  Tabloid: { width: 11, height: 17 },
};

export function parseInches(v?: string): number | undefined {
  if (!v) return undefined;
  const m = /^([\d.]+)(in|mm|cm|px)?$/.exec(v.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]!);
  const unit = m[2] ?? 'in';
  if (unit === 'in') return n;
  if (unit === 'mm') return n / 25.4;
  if (unit === 'cm') return n / 2.54;
  if (unit === 'px') return n / 96;
  return undefined;
}
