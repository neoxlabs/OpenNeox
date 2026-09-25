/**
 * svgPathToCustGeom — SVG path `d` → OOXML `<a:custGeom>`
 *
 * ════════════════════════════════════════════════════════════════════════
 * 为什么要有这个文件 (, 明康)
 * ------------------------------------------------------------------------
 * 在此之前我们导出 PPT 只会写 `<a:prstGeom>` —— PowerPoint 内置的那 180 多个预设
 * 形状。预设就那么多、谁用都长一样, 所以市面上的 AI PPT 全是"模板堆砌", 一眼假。
 * 想要 WPS 稻壳那种级别的版式 (不规则色块 / 丝带 / 弧形分割 / 有艺术细节的箭头),
 * 预设形状永远画不出来。
 *
 * OOXML 的答案是 `<a:custGeom>` —— 自定义几何路径。它的指令集和 SVG path
 * **一一对应**, 所以这是一个纯机械的、可完全自动化的转换:
 *
 *     SVG          custGeom
 *     M            a:moveTo
 *     L H V        a:lnTo
 *     C S          a:cubicBezTo
 *     Q T          a:quadBezTo
 *     A            a:arcTo      (要做椭圆弧参数 → 圆心角换算, 见 arcToOoxml)
 *     Z            a:close
 *
 * 转出来的是**真·可编辑图形**: 在 PowerPoint / WPS 里能选中、能改填充、能拖节点,
 * 不是贴图。这是整条"HTML/SVG 创作 → 可编辑 PPT"链路的地基。
 *
 * 为什么让模型产 SVG 而不是直接产 OOXML: 模型写 SVG 的训练数据比 DrawingML 多几个
 * 数量级, 让它直接吐 OOXML 是逆着能力走。产 SVG → 我们转, 才是顺的。
 * ════════════════════════════════════════════════════════════════════════
 */

/** custGeom 的路径坐标空间。用固定大数 = 亚像素精度, 且和形状实际尺寸解耦。 */
export const CUST_GEOM_SPACE = 21600;

export interface SvgPathToCustGeomOptions {
  /**
   * path 所在的 SVG 用户坐标系尺寸 (viewBox 的 w/h)。
   * 路径会被等比映射到 0..CUST_GEOM_SPACE 的方形空间里 —— OOXML 用 path 的
   * w/h 属性声明这个空间, PowerPoint 再把它拉伸到形状的实际 frame。
   */
  viewBoxWidth: number;
  viewBoxHeight: number;
  /** 只描边不填充的路径 (比如分隔线)。默认 false = 填充。 */
  strokeOnly?: boolean;
}

export class SvgPathParseError extends Error {
  constructor(message: string, readonly at?: number) {
    super(message);
    this.name = 'SvgPathParseError';
  }
}

/* ============================================================
 * 1. 词法: 把 d 字符串切成 [指令, 数字...] 序列
 * ============================================================ */

interface RawSegment {
  cmd: string;
  args: number[];
}

/** SVG 数字: 支持 .5 / -.5 / 1e-3 / 1.5.5 (连写, 第二个点开始新数字) */
const NUMBER_RE = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

/** 每个指令期望的参数个数 (一组) */
const ARITY: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
};

export function tokenizeSvgPath(d: string): RawSegment[] {
  const out: RawSegment[] = [];
  const src = String(d ?? '').trim();
  if (!src) return out;

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/[\s,]/.test(ch)) { i++; continue; }
    if (!/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
      throw new SvgPathParseError(`Unexpected character '${ch}' in path`, i);
    }
    const cmd = ch;
    i++;
    /* 收集到下一个指令字母之前的所有数字 */
    let j = i;
    while (j < src.length && !/[MmLlHhVvCcSsQqTtAaZz]/.test(src[j]!)) j++;
    const chunk = src.slice(i, j);
    i = j;

    const upper = cmd.toUpperCase();
    const arity = ARITY[upper];
    if (arity === undefined) throw new SvgPathParseError(`Unknown command '${cmd}'`);

    if (arity === 0) { out.push({ cmd, args: [] }); continue; }

    const nums = parseNumbers(chunk, upper);
    if (nums.length === 0 || nums.length % arity !== 0) {
      throw new SvgPathParseError(
        `Command '${cmd}' expects a multiple of ${arity} numbers, got ${nums.length}`,
      );
    }
    /* 隐式重复: "L 1 2 3 4" == "L 1 2 L 3 4"; "M x y x2 y2" 的后续组是 lineTo (SVG 规范) */
    for (let k = 0; k < nums.length; k += arity) {
      const group = nums.slice(k, k + arity);
      const effective = (upper === 'M' && k > 0)
        ? (cmd === 'M' ? 'L' : 'l')
        : cmd;
      out.push({ cmd: effective, args: group });
    }
  }
  return out;
}

/** arcTo 的 flag 参数可以不带分隔符连写 (a1 1 0 011 1) —— 单独处理 */
function parseNumbers(chunk: string, upper: string): number[] {
  if (upper !== 'A') {
    const nums = chunk.match(NUMBER_RE) ?? [];
    /* 把数字挖掉后必须只剩分隔符 —— 否则是脏字符 (比如 "M0 0 X" 里的 X)。
     * 不校验的话脏字符被静默丢弃, 画出来少一段, 而且没有任何报错。 */
    const rest = chunk.replace(NUMBER_RE, '').trim();
    if (rest && /[^\s,]/.test(rest)) {
      throw new SvgPathParseError(`Unexpected token '${rest.trim()}' after command '${upper}'`);
    }
    return nums.map(Number);
  }
  /* A 的第 4/5 个参数是 0|1 的 flag, 规范允许 "011" 这种连写 */
  const out: number[] = [];
  let idx = 0;
  const s = chunk;
  const skipSep = () => { while (idx < s.length && /[\s,]/.test(s[idx]!)) idx++; };
  while (idx < s.length) {
    skipSep();
    if (idx >= s.length) break;
    const slot = out.length % 7;
    if (slot === 3 || slot === 4) {
      const c = s[idx]!;
      if (c !== '0' && c !== '1') {
        throw new SvgPathParseError(`Arc flag must be 0 or 1, got '${c}'`, idx);
      }
      out.push(Number(c));
      idx++;
      continue;
    }
    NUMBER_RE.lastIndex = idx;
    const m = NUMBER_RE.exec(s);
    if (!m || m.index !== idx) {
      throw new SvgPathParseError(`Bad number in arc at offset ${idx}`, idx);
    }
    out.push(Number(m[0]));
    idx = m.index + m[0].length;
  }
  return out;
}

/* ============================================================
 * 2. 规范化: 相对 → 绝对, H/V/S/T 展开成 L/C/Q
 * ============================================================ */

export interface AbsSegment {
  cmd: 'M' | 'L' | 'C' | 'Q' | 'A' | 'Z';
  args: number[];
}

export function normalizeSvgPath(segments: RawSegment[]): AbsSegment[] {
  const out: AbsSegment[] = [];
  let cx = 0, cy = 0;          /* 当前点 */
  let sx = 0, sy = 0;          /* 子路径起点 (Z 回到这里) */
  let prevCtrl: { x: number; y: number } | null = null;  /* 上一段的第二控制点 (S 用) */
  let prevQCtrl: { x: number; y: number } | null = null; /* 上一段的 Q 控制点 (T 用) */

  for (const seg of segments) {
    const rel = seg.cmd === seg.cmd.toLowerCase() && seg.cmd !== 'Z' && seg.cmd !== 'z';
    const u = seg.cmd.toUpperCase();
    const a = seg.args;

    switch (u) {
      case 'M': {
        const x = rel ? cx + a[0]! : a[0]!;
        const y = rel ? cy + a[1]! : a[1]!;
        out.push({ cmd: 'M', args: [x, y] });
        cx = sx = x; cy = sy = y;
        prevCtrl = prevQCtrl = null;
        break;
      }
      case 'L': {
        const x = rel ? cx + a[0]! : a[0]!;
        const y = rel ? cy + a[1]! : a[1]!;
        out.push({ cmd: 'L', args: [x, y] });
        cx = x; cy = y;
        prevCtrl = prevQCtrl = null;
        break;
      }
      case 'H': {
        const x = rel ? cx + a[0]! : a[0]!;
        out.push({ cmd: 'L', args: [x, cy] });
        cx = x;
        prevCtrl = prevQCtrl = null;
        break;
      }
      case 'V': {
        const y = rel ? cy + a[0]! : a[0]!;
        out.push({ cmd: 'L', args: [cx, y] });
        cy = y;
        prevCtrl = prevQCtrl = null;
        break;
      }
      case 'C': {
        const x1 = rel ? cx + a[0]! : a[0]!, y1 = rel ? cy + a[1]! : a[1]!;
        const x2 = rel ? cx + a[2]! : a[2]!, y2 = rel ? cy + a[3]! : a[3]!;
        const x = rel ? cx + a[4]! : a[4]!, y = rel ? cy + a[5]! : a[5]!;
        out.push({ cmd: 'C', args: [x1, y1, x2, y2, x, y] });
        prevCtrl = { x: x2, y: y2 }; prevQCtrl = null;
        cx = x; cy = y;
        break;
      }
      case 'S': {
        /* 平滑三次: 第一控制点 = 当前点关于上一段第二控制点的映射 */
        const r: { x: number; y: number } = prevCtrl
          ? { x: 2 * cx - prevCtrl.x, y: 2 * cy - prevCtrl.y }
          : { x: cx, y: cy };
        const x2 = rel ? cx + a[0]! : a[0]!, y2 = rel ? cy + a[1]! : a[1]!;
        const x = rel ? cx + a[2]! : a[2]!, y = rel ? cy + a[3]! : a[3]!;
        out.push({ cmd: 'C', args: [r.x, r.y, x2, y2, x, y] });
        prevCtrl = { x: x2, y: y2 }; prevQCtrl = null;
        cx = x; cy = y;
        break;
      }
      case 'Q': {
        const x1 = rel ? cx + a[0]! : a[0]!, y1 = rel ? cy + a[1]! : a[1]!;
        const x = rel ? cx + a[2]! : a[2]!, y = rel ? cy + a[3]! : a[3]!;
        out.push({ cmd: 'Q', args: [x1, y1, x, y] });
        prevQCtrl = { x: x1, y: y1 }; prevCtrl = null;
        cx = x; cy = y;
        break;
      }
      case 'T': {
        const r: { x: number; y: number } = prevQCtrl
          ? { x: 2 * cx - prevQCtrl.x, y: 2 * cy - prevQCtrl.y }
          : { x: cx, y: cy };
        const x = rel ? cx + a[0]! : a[0]!, y = rel ? cy + a[1]! : a[1]!;
        out.push({ cmd: 'Q', args: [r.x, r.y, x, y] });
        prevQCtrl = { x: r.x, y: r.y }; prevCtrl = null;
        cx = x; cy = y;
        break;
      }
      case 'A': {
        const x = rel ? cx + a[5]! : a[5]!, y = rel ? cy + a[6]! : a[6]!;
        out.push({ cmd: 'A', args: [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, x, y, cx, cy] });
        prevCtrl = prevQCtrl = null;
        cx = x; cy = y;
        break;
      }
      case 'Z': {
        out.push({ cmd: 'Z', args: [] });
        cx = sx; cy = sy;
        prevCtrl = prevQCtrl = null;
        break;
      }
    }
  }
  return out;
}

/* ============================================================
 * 3. 椭圆弧: SVG endpoint 参数 → OOXML center/角度 参数
 * ============================================================
 * SVG 的 A 给的是"终点 + 半径 + 旋转 + 两个 flag";
 * OOXML 的 a:arcTo 要的是"半径 + 起始角 + 扫过角" (单位: 1/60000 度, y 轴向下为正)。
 * 这段换算照 SVG 1.1 规范 F.6.5 的 endpoint→center 公式来。
 *
 *  已知限制: OOXML arcTo 不支持 x-axis-rotation。带旋转的弧 (罕见) 会被拆成
 *    三次贝塞尔近似, 见 arcToBeziers。
 */

interface ArcCenterParams {
  cx: number; cy: number;
  rx: number; ry: number;
  startAngle: number;  /* 弧度 */
  deltaAngle: number;  /* 弧度, 带符号 */
}

export function arcEndpointToCenter(
  x1: number, y1: number,
  rx: number, ry: number,
  phiDeg: number,
  largeArc: number, sweep: number,
  x2: number, y2: number,
): ArcCenterParams | null {
  if (x1 === x2 && y1 === y2) return null;   /* 规范: 起终点重合 = 不画 */
  let rX = Math.abs(rx), rY = Math.abs(ry);
  if (rX === 0 || rY === 0) return null;     /* 规范: 半径为 0 = 直线, 调用方处理 */

  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);

  const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  /* 半径过小时按规范放大 */
  const lambda = (x1p * x1p) / (rX * rX) + (y1p * y1p) / (rY * rY);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rX *= s; rY *= s;
  }

  const sign = largeArc !== sweep ? 1 : -1;
  const num = rX * rX * rY * rY - rX * rX * y1p * y1p - rY * rY * x1p * x1p;
  const den = rX * rX * y1p * y1p + rY * rY * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));

  const cxp = co * (rX * y1p) / rY;
  const cyp = co * -(rY * x1p) / rX;

  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / (len || 1))));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const startAngle = angle(1, 0, (x1p - cxp) / rX, (y1p - cyp) / rY);
  let deltaAngle = angle(
    (x1p - cxp) / rX, (y1p - cyp) / rY,
    (-x1p - cxp) / rX, (-y1p - cyp) / rY,
  );
  if (sweep === 0 && deltaAngle > 0) deltaAngle -= 2 * Math.PI;
  if (sweep === 1 && deltaAngle < 0) deltaAngle += 2 * Math.PI;

  return { cx, cy, rx: rX, ry: rY, startAngle, deltaAngle };
}

/** 带 x 轴旋转的弧 OOXML 表达不了 —— 拆成三次贝塞尔 (每段 ≤ 90°)。 */
export function arcToBeziers(p: ArcCenterParams, phiDeg: number): number[][] {
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const segCount = Math.max(1, Math.ceil(Math.abs(p.deltaAngle) / (Math.PI / 2)));
  const delta = p.deltaAngle / segCount;
  const t = (4 / 3) * Math.tan(delta / 4);

  const point = (ang: number): [number, number] => {
    const x = p.rx * Math.cos(ang), y = p.ry * Math.sin(ang);
    return [p.cx + cosPhi * x - sinPhi * y, p.cy + sinPhi * x + cosPhi * y];
  };
  const deriv = (ang: number): [number, number] => {
    const x = -p.rx * Math.sin(ang), y = p.ry * Math.cos(ang);
    return [cosPhi * x - sinPhi * y, sinPhi * x + cosPhi * y];
  };

  const out: number[][] = [];
  let a0 = p.startAngle;
  for (let i = 0; i < segCount; i++) {
    const a1 = a0 + delta;
    const [x0, y0] = point(a0), [x1, y1] = point(a1);
    const [dx0, dy0] = deriv(a0), [dx1, dy1] = deriv(a1);
    out.push([x0 + t * dx0, y0 + t * dy0, x1 - t * dx1, y1 - t * dy1, x1, y1]);
    a0 = a1;
  }
  return out;
}

/* ============================================================
 * 4. 生成 OOXML
 * ============================================================ */

/** OOXML 角度单位: 1/60000 度。y 轴向下, 和 SVG 一致, 所以角度不用翻转。 */
const OOXML_ANGLE = 60000;
const rad2ooxml = (r: number): number => Math.round((r * 180 / Math.PI) * OOXML_ANGLE);

export function svgPathToCustGeom(d: string, opts: SvgPathToCustGeomOptions): string {
  const { viewBoxWidth: vw, viewBoxHeight: vh, strokeOnly } = opts;
  if (!(vw > 0) || !(vh > 0)) {
    throw new SvgPathParseError(`viewBox must be positive, got ${vw}x${vh}`);
  }

  const segments = normalizeSvgPath(tokenizeSvgPath(d));
  if (segments.length === 0) {
    throw new SvgPathParseError('Empty path');
  }

  /* 等比映射到 21600 方形空间。x/y 各自按自己的边归一化 —— PowerPoint 会把
   * path 的 w/h 拉伸到形状 frame, 所以这里保持"填满 viewBox"的语义。 */
  const sx = CUST_GEOM_SPACE / vw;
  const sy = CUST_GEOM_SPACE / vh;
  const X = (v: number) => Math.round(v * sx);
  const Y = (v: number) => Math.round(v * sy);
  const pt = (x: number, y: number) => `<a:pt x="${X(x)}" y="${Y(y)}"/>`;

  const body: string[] = [];
  for (const seg of segments) {
    const a = seg.args;
    switch (seg.cmd) {
      case 'M':
        body.push(`<a:moveTo>${pt(a[0]!, a[1]!)}</a:moveTo>`);
        break;
      case 'L':
        body.push(`<a:lnTo>${pt(a[0]!, a[1]!)}</a:lnTo>`);
        break;
      case 'C':
        body.push(`<a:cubicBezTo>${pt(a[0]!, a[1]!)}${pt(a[2]!, a[3]!)}${pt(a[4]!, a[5]!)}</a:cubicBezTo>`);
        break;
      case 'Q':
        body.push(`<a:quadBezTo>${pt(a[0]!, a[1]!)}${pt(a[2]!, a[3]!)}</a:quadBezTo>`);
        break;
      case 'Z':
        body.push('<a:close/>');
        break;
      case 'A': {
        const [rx, ry, phi, largeArc, sweep, x2, y2, x1, y1] = a as [
          number, number, number, number, number, number, number, number, number,
        ];
        const c = arcEndpointToCenter(x1, y1, rx, ry, phi, largeArc, sweep, x2, y2);
        if (!c) {
          /* 半径 0 / 起终点重合 → 规范说当直线 */
          body.push(`<a:lnTo>${pt(x2, y2)}</a:lnTo>`);
          break;
        }
        if (Math.abs(phi % 180) > 1e-6) {
          /* OOXML arcTo 没有 x 轴旋转 —— 降级成贝塞尔, 视觉无损 */
          for (const b of arcToBeziers(c, phi)) {
            body.push(`<a:cubicBezTo>${pt(b[0]!, b[1]!)}${pt(b[2]!, b[3]!)}${pt(b[4]!, b[5]!)}</a:cubicBezTo>`);
          }
          break;
        }
        /* arcTo 的半径要按各自轴缩放后再写 —— 它和坐标用同一个空间 */
        body.push(
          `<a:arcTo wR="${Math.round(c.rx * sx)}" hR="${Math.round(c.ry * sy)}"`
          + ` stAng="${rad2ooxml(c.startAngle)}" swAng="${rad2ooxml(c.deltaAngle)}"/>`,
        );
        break;
      }
    }
  }

  const fillAttr = strokeOnly ? 'none' : 'norm';
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/>`
    + `<a:rect l="0" t="0" r="r" b="b"/>`
    + `<a:pathLst><a:path w="${CUST_GEOM_SPACE}" h="${CUST_GEOM_SPACE}" fill="${fillAttr}">`
    + body.join('')
    + `</a:path></a:pathLst></a:custGeom>`;
}

/* ============================================================
 * 5. 圆角化: 把折线路径的尖角磨成圆角
 * ============================================================
 *  明康对比 WPS 原图: "有的椭圆…原图是椭圆的, 但是你没有椭圆圆角"。
 *
 * 这是"精致 vs 廉价"最直接的一条分界线。WPS 那些模板里的箭羽 / 色块 / 丝带,
 * 拐角几乎没有一个是尖的 —— 全是小圆角。而 SVG path 写出来默认全是尖角,
 * 模型也不会自己去补圆角 (要它手写每个拐角的两条切点 + 一段弧, 基本必错)。
 *
 * 所以圆角应该是**渲染层的能力**, 不是让模型去算的东西: 模型给折线轮廓,
 * 我们按半径自动磨角。半径超过邻边一半时自动收敛, 不会自交。
 *
 * 只处理直线-直线的拐角 —— 曲线拐角本身就是圆滑的, 不需要动。
 */

/** 路径顶点圆角化。radius 单位 = 传入 path 的用户坐标。 */
export function roundPathCorners(d: string, radius: number): string {
  if (!(radius > 0)) return d;
  const segs = normalizeSvgPath(tokenizeSvgPath(d));

  /* 按子路径切开 (M ... Z) —— 圆角只在子路径内部处理 */
  const out: string[] = [];
  let i = 0;
  while (i < segs.length) {
    if (segs[i]!.cmd !== 'M') { out.push(emit(segs[i]!)); i++; continue; }
    let j = i + 1;
    while (j < segs.length && segs[j]!.cmd !== 'M') j++;
    const sub = segs.slice(i, j);
    out.push(roundSubpath(sub, radius));
    i = j;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function emit(s: AbsSegment): string {
  const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
  switch (s.cmd) {
    case 'M': return `M${n(s.args[0]!)} ${n(s.args[1]!)}`;
    case 'L': return `L${n(s.args[0]!)} ${n(s.args[1]!)}`;
    case 'C': return `C${s.args.slice(0, 6).map(n).join(' ')}`;
    case 'Q': return `Q${s.args.slice(0, 4).map(n).join(' ')}`;
    case 'A': return `A${s.args.slice(0, 5).map(n).join(' ')} ${n(s.args[5]!)} ${n(s.args[6]!)}`;
    case 'Z': return 'Z';
  }
}

function roundSubpath(sub: AbsSegment[], radius: number): string {
  const closed = sub[sub.length - 1]?.cmd === 'Z';
  /* 收集顶点序列; 只有全是 M/L 的纯折线才做圆角 (曲线拐角本来就圆滑) */
  const pts: Array<[number, number]> = [];
  for (const s of sub) {
    if (s.cmd === 'M' || s.cmd === 'L') pts.push([s.args[0]!, s.args[1]!]);
    else if (s.cmd !== 'Z') return sub.map(emit).join(' ');  /* 含曲线 → 原样返回 */
  }
  /* 闭合路径里最后一点和起点重合时去重, 免得磨出一个零长度角 */
  if (closed && pts.length > 2) {
    const a = pts[0]!, b = pts[pts.length - 1]!;
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) pts.pop();
  }
  if (pts.length < 3) return sub.map(emit).join(' ');

  const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
  const parts: string[] = [];
  const last = pts.length - 1;

  for (let k = 0; k <= last; k++) {
    const cur = pts[k]!;
    const prev = pts[(k - 1 + pts.length) % pts.length]!;
    const next = pts[(k + 1) % pts.length]!;

    /* 开放路径的首尾顶点不磨 —— 它们是端点不是拐角 */
    const isEndpoint = !closed && (k === 0 || k === last);
    if (isEndpoint) {
      parts.push(`${k === 0 ? 'M' : 'L'}${n(cur[0])} ${n(cur[1])}`);
      continue;
    }

    const v1 = [prev[0] - cur[0], prev[1] - cur[1]] as const;
    const v2 = [next[0] - cur[0], next[1] - cur[1]] as const;
    const l1 = Math.hypot(v1[0], v1[1]);
    const l2 = Math.hypot(v2[0], v2[1]);
    if (l1 < 1e-9 || l2 < 1e-9) {
      parts.push(`${k === 0 ? 'M' : 'L'}${n(cur[0])} ${n(cur[1])}`);
      continue;
    }
    /* 半径不能超过任一邻边的一半, 否则相邻圆角会互相吃掉 → 路径自交 */
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const p1 = [cur[0] + (v1[0] / l1) * r, cur[1] + (v1[1] / l1) * r] as const;
    const p2 = [cur[0] + (v2[0] / l2) * r, cur[1] + (v2[1] / l2) * r] as const;

    if (k === 0) parts.push(`M${n(p1[0])} ${n(p1[1])}`);
    else parts.push(`L${n(p1[0])} ${n(p1[1])}`);
    /* 二次贝塞尔, 控制点就是原顶点 —— 视觉上等价于圆角, 且不用解圆心 */
    parts.push(`Q${n(cur[0])} ${n(cur[1])} ${n(p2[0])} ${n(p2[1])}`);
  }

  if (closed) parts.push('Z');
  return parts.join(' ');
}
