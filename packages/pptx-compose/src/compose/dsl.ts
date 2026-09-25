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
 *]),
 *         VStack({ flex: 1, gap: 8 }, [
 *           Text('晚上·江景与夜食', { fontSize: 20, bold: true, color: '#C05621' }),
 *           Text('19:00 黄浦江两岸亮灯...', { fontSize: 18 }),
 *]),
 *]),
 *])
 *);
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

/**
 * 弹性间隔 —— 吃掉主轴上的剩余空间, 把两侧内容顶开。
 *
 * 【 实现】以前它是个**空操作**: 工厂只接 minLength, 没有 flex,
 * measure 又返回 0×0 —— 于是 `Spacer({})` 什么都不做。而 DSL 头部的示例和
 * cover-hero / manifesto / heroImageQuote 里的注释都写着"推内容到底",
 * 读代码的人 (和照文档写的 agent) 会以为它在干活。
 *
 * 现在: 默认 flex:1 (所以能吃掉剩余空间), minLength 是它的**最低**尺寸。
 * 要两段空白按比例分配就给不同的 flex。
 */
export function Spacer(params?: { minLength?: number; flex?: number }): SpacerNode {
  return { kind: 'spacer', layoutParams: { flex: params?.flex ?? 1, ...params } };
}

/**
 * 把调用方给的东西规范成一个可排版的字符串。
 *
 * 【 类型对抗测试抓出】15 种"agent 传错类型"的用例里 **9 种直接抛异常**,
 * 而且几乎都是同一条毫无信息量的消息: `text.split is not a function` /
 * `Cannot read properties of undefined (reading 'split')` ——
 * 那个 split 在 measureText 深处, **报错完全不说是哪个槽位错了**, agent 没法自愈。
 *
 * 分三种处理, 判据是"调用方的意图清不清楚":
 *   · number / boolean —— 意图明确 (`title: 42`), 直接转成字符串
 *   · null / undefined —— 缺值, 当空串 (缺个 label 不该让整页崩掉)
 *   · 对象 / 数组 —— **意图不明**, 渲染成 "[object Object]" 是静默画坏,
 *     所以明确报错, 并把拿到的东西打出来让人一眼看出传错了什么
 */
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
