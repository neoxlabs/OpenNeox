/* ============================================================
 * expandPack — 从 ThemePackSeed 派生完整 ThemePackTokens
 *
 * 设计目标: pack 定义者只给 5 个色值 (canvas/accent/textPrimary + 可选 panel/card),
 * 派生函数自动生成 40+ 个 token. 这是把 16 包总体维护成本压到最低的关键.
 *
 * 派生策略:
 *   light pack: surface 之间用 mix(canvas, accent, 0.0x) 微染色, text 用纯黑/灰阶
 *   dark  pack: surface 走 R=G=B 中性灰 (沉淀经验, 见 [[feedback_neutral_gray_surfaces]]),
 *               text 走 #ebebeb 灰白阶, accent 不能大面积填充 (沉淀 [[feedback_moye_primary_is_fg_not_bg]])
 * ============================================================ */

import { alpha, darken, inkOn, lighten, mix, semanticInkOn } from './colorUtils';
import type { ThemePackSeed, ThemePackTokens } from './types';

export const expandPack = (seed: ThemePackSeed): ThemePackTokens => {
  const isDark = seed.mode === 'dark';
  const accent = seed.accent;
  const canvas = seed.canvas;
  const text = seed.textPrimary;

  /* ===== Surface =====
   * 关键: card/muted/hover 走 rgba 半透明, 这样 legacy 元素 (用 --neox-bg-card) 自动跟主题:
   * dark 主题: 白色 alpha 微叠加 = wallpaper 透出
   * light 主题: 白色 alpha 中等叠加 = 玻璃片质感
   * 只有 canvas / panel 保留实色 (给真需要实底的元素, e.g. Monaco 内置)
   */
  /* panel = 悬浮/次级面板. 关键: 暗色下 panel 必须比 canvas 亮 (elevated 向上),
   * 不然右侧 Word 这种悬浮卡比底色还暗, 层级反向, 视觉脏. 浅色下保持原 lighten(canvas,0.20). */
  const panel = seed.panel ?? (isDark ? lighten(canvas, 0.10) : lighten(canvas, 0.20));
  const card  = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.55)';
  /* 悬浮层的**不透明**面 —— card 是半透明的 (整套玻璃观感靠它), 但下拉/菜单/气泡
   * 浮在正文之上, 用半透明面会把底下的字透上来跟选项叠在一起。
   * 从 canvas/panel 派生保证它仍然属于这个主题包, 而不是一块生白/死黑。 */
  const elevated = isDark ? darken(panel, 0.42) : lighten(canvas, 0.72);
  const muted = isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(255, 255, 255, 0.30)';
  const hover = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.05)';
  const sunken = isDark ? 'rgba(0, 0, 0, 0.20)' : 'rgba(15, 23, 42, 0.04)';

  /* ===== Accent ramp — 11 档, accent 落在 600
   * dark mode 下 ramp 还是用 accent 派生 (用作"强调线/文字"而非"大面积填充"),
   *   ↳ primary-50/100/200 偏暗用于 chip 软底, 不会出现大面积亮色刺眼
   * light mode 下 ramp 是标准 50→900 渐变 */
  const primary600 = accent;
  const primary500 = lighten(accent, 0.10);
  const primary400 = lighten(accent, 0.20);
  const primary300 = lighten(accent, 0.35);
  const primary200 = lighten(accent, 0.55);
  const primary100 = isDark ? darken(accent, 0.65) : lighten(accent, 0.78);
  const primary50  = isDark ? darken(accent, 0.78) : lighten(accent, 0.88);
  const primary25  = isDark ? darken(accent, 0.85) : lighten(accent, 0.94);
  const primary700 = darken(accent, 0.12);
  const primary800 = darken(accent, 0.25);
  const primary900 = darken(accent, 0.40);

  /* ===== Text =====
   * 三档次级文字按**画布**推导, 而不是按明暗模式取固定灰。
   *
   * 固定灰只在画布接近纯白或纯黑时成立。主题包的画布是任意色 —— 香芋啵啵的 #bcb0e8
   * 是饱和中间调, 一个 #787878 压上去只有 2.21:1, 而 WCAG AA 正文要 4.5:1;
   * 同一个灰在不同包上能差出三倍对比度。inkOn 从画布朝对比更强的一极推到刚好够,
   * 于是每个包、包括以后新增的包, 这三档都自带下限。
   *
   * 目标值拉开档距 (8 / 6 / 4.6) 是为了保住层级: 三档挤在一起就等于只有一档。 */
  const fgSecondary = inkOn(canvas, 8);
  const fgMuted     = inkOn(canvas, 6);
  const fgHint      = inkOn(canvas, 4.6);
  const fgInvert    = isDark ? '#1b1b1b' : '#ffffff';
  const fgCode      = isDark ? '#e8e8e8' : darken(accent, 0.20);
  const fgSecondaryLight = fgSecondary;

  /* ===== Lines ===== */
  const line       = isDark ? '#363636' : darken(canvas, 0.10);
  const lineSoft   = isDark ? '#2c2c2c' : darken(canvas, 0.06);
  const lineStrong = isDark ? '#474747' : darken(canvas, 0.18);
  const lineSubtle = isDark ? '#2c2c2c' : darken(canvas, 0.04);

  /* ===== Semantic ===== */
  const warn = isDark ? '#ffb84d' : '#d97706';
  const err  = isDark ? '#ef6b6b' : '#dc2626';
  const ok   = isDark ? '#5fb46a' : '#10b981';

  /* ===== Glass surface ===== */
  const glassBg     = isDark ? alpha(panel, 0.75) : alpha(card, 0.80);
  const glassBorder = isDark ? alpha('#ffffff', 0.10) : alpha('#000000', 0.06);

  /* ===== Shadow — 暗色阴影深, 亮色阴影柔 ===== */
  const shadow1 = isDark
    ? '0 1px 2px rgba(0, 0, 0, 0.40)'
    : '0 1px 2px rgba(15, 23, 42, 0.06)';
  const shadow2 = isDark
    ? '0 4px 14px rgba(0, 0, 0, 0.45)'
    : '0 8px 24px rgba(15, 23, 42, 0.08)';
  const shadow3 = isDark
    ? '0 14px 36px -12px rgba(0, 0, 0, 0.60)'
    : '0 20px 50px -12px rgba(15, 23, 42, 0.15)';

  return {
    bgCanvas: canvas,
    bgPanel: panel,
    bgCard: card,
    bgElevated: elevated,
    bgMuted: muted,
    bgHover: hover,
    bgSunken: sunken,

    primary900,
    primary800,
    primary700,
    primary600,
    primary500,
    primary400,
    primary300,
    primary200,
    primary100,
    primary50,
    primary25,
    primaryRing: alpha(accent, 0.22),

    fgPrimary: text,
    fgSecondary: fgSecondaryLight,
    fgMuted,
    fgHint,
    fgInvert,
    fgCode,

    line, lineSoft, lineStrong, lineSubtle,

    /* *Ink 是"这个语义色写在画布上的那一档", 跟 warn/err/ok 本身 (点、条、填充用) 分开。
     * 同样按画布推而不是写死: 固定值只对白底或纯黑底成立, 换成主题包的彩色画布就塌 ——
     * 右栏那个 12px 的 "+624" 在香芋啵啵上曾经只有 1.65:1。 */
    warn,     warnSoft: alpha(warn, isDark ? 0.12 : 0.10), warnInk: semanticInkOn(warn, canvas, 4.6),
    err,      errSoft:  alpha(err,  isDark ? 0.12 : 0.10), errInk:  semanticInkOn(err,  canvas, 4.6),
    ok,       okSoft:   alpha(ok,   isDark ? 0.12 : 0.10), okInk:   semanticInkOn(ok,   canvas, 4.6),

    glassBg, glassBorder,
    cardBg: card,
    cardBorder: line,

    shadow1, shadow2, shadow3,
  };
};
