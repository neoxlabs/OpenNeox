/**
 * compose/dsl — 声明式 DSL 建造函数. Agent 用这些函数搭 layout 树.
 *
 * 用法示例:
 *   slide.render(
 *     VStack({ padding: 32, gap: 16 }, [
 *       Text('DAY 01', { role: 'text', uppercase: true, color: '#C05621' }),
 *       Text('外滩不止一面', { fontSize: 36, bold: true, role: 'display' }),
 *       Spacer({ minLength: 24 }),
 *       HStack({ gap: 16 }, [
 *         VStack({ flex: 1, gap: 8 }, [
 *           Text('下午·老城与外滩', { fontSize: 20, bold: true, color: '#C05621' }),
 *           Text('豫园 · 九曲桥 · 白墙黛瓦...', { fontSize: 18 }),
 *         ]),
 *         VStack({ flex: 1, gap: 8 }, [
 *           Text('晚上·江景与夜食', { fontSize: 20, bold: true, color: '#C05621' }),
 *           Text('19:00 黄浦江两岸亮灯...', { fontSize: 18 }),
 *         ]),
 *       ]),
 *     ])
 *   );
 */

import type {
  VStackNode, HStackNode, ZStackNode, GridNode, SpacerNode,
  TextNode, ImageNode, ShapeNode, TableNode,
  LayoutNode, StackParams, LayoutParams,
  TextParams, ImageParams, ShapeParams, TableParams,
} from './types.js';

export function VStack(params: StackParams, children: LayoutNode[]): VStackNode;
export function VStack(children: LayoutNode[]): VStackNode;
export function VStack(a: StackParams | LayoutNode[], b?: LayoutNode[]): VStackNode {
  if (Array.isArray(a)) return { kind: 'vstack', layoutParams: {}, children: a };
  return { kind: 'vstack', layoutParams: a, children: b ?? [] };
}

export function HStack(params: StackParams, children: LayoutNode[]): HStackNode;
export function HStack(children: LayoutNode[]): HStackNode;
export function HStack(a: StackParams | LayoutNode[], b?: LayoutNode[]): HStackNode {
  if (Array.isArray(a)) return { kind: 'hstack', layoutParams: {}, children: a };
  return { kind: 'hstack', layoutParams: a, children: b ?? [] };
}

export function ZStack(params: LayoutParams & { align?: 'start' | 'center' | 'end' }, children: LayoutNode[]): ZStackNode;
export function ZStack(children: LayoutNode[]): ZStackNode;
export function ZStack(a: any, b?: LayoutNode[]): ZStackNode {
  if (Array.isArray(a)) return { kind: 'zstack', layoutParams: {}, children: a };
  return { kind: 'zstack', layoutParams: a, children: b ?? [] };
}

export function Grid(params: LayoutParams & { columns: number; rowGap?: number; colGap?: number }, children: LayoutNode[]): GridNode {
  return { kind: 'grid', layoutParams: params, children };
}

export function Spacer(params?: { minLength?: number; flex?: number }): SpacerNode {
  return { kind: 'spacer', layoutParams: { flex: params?.flex ?? 1, ...params } };
}

function normalizeText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const got = Array.isArray(v) ? `数组(${v.length} 项)` : `对象(${Object.keys(v as object).slice(0, 4).join(', ')})`;
  throw new TypeError(
    `Text() 收到的不是文本, 而是${got}。检查一下模板槽位的形状 —— `
    + `比如 columns 要的是 [{ title, body }] 而不是 ['一','二'], `
    + `body 要的是字符串数组。原值: ${JSON.stringify(v).slice(0, 120)}`,
  );
}

export function Text(text: string, params?: TextParams): TextNode {
  return { kind: 'text', text: normalizeText(text), layoutParams: params };
}

export function Image(
  source: NonNullable<ImageNode['source']>,
  params?: ImageParams,
): ImageNode {
  return { kind: 'image', source, layoutParams: params };
}

export function Shape(params: ShapeParams): ShapeNode {
  return { kind: 'shape', layoutParams: params };
}

export function Table(
  headers: string[],
  rows: string[][],
  params?: TableParams,
): TableNode {
  return { kind: 'table', headers, rows, layoutParams: params };
}
