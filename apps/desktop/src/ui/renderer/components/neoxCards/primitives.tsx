
import React from 'react';


/** 数字兜底 — 模型经常把数字写成字符串 ("+134" / "134"), 都认 */
export const numOf = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? '').replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** 路径省略 — 只留最后两段, 完整路径进 title */
export const shortPath = (p: string): string => {
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
};

/** 目录段 (含尾斜杠) / 文件名 — 分开渲染, 目录压暗、文件名给主色, 长路径不再一坨等重灰字 */
export const baseOf = (p: string): string => (p.split(/[/\\]/).filter(Boolean).pop() || p);
export const dirOf = (p: string): string => {
  const parts = p.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 1) return '';
  const dirs = parts.slice(0, -1);
  const shown = dirs.length > 2 ? ['…', ...dirs.slice(-1)] : dirs;
  return shown.join('/') + '/';
};

export type Tone = 'good' | 'warn' | 'bad' | 'info';
export const normTone = (v: unknown): Tone => {
  const s = String(v ?? '').toLowerCase();
  if (s === 'good' || s === 'ok' || s === 'success') return 'good';
  if (s === 'warn' || s === 'warning') return 'warn';
  if (s === 'bad' || s === 'error' || s === 'fail' || s === 'failed') return 'bad';
  return 'info';
};


export type GlyphName =
  | 'check' | 'alert' | 'cross' | 'info' | 'bug' | 'shield' | 'bolt' | 'network'
  | 'database' | 'code' | 'file' | 'test' | 'clock' | 'git' | 'lock' | 'rocket'
  | 'search' | 'eye' | 'wrench' | 'package' | 'terminal' | 'chart' | 'doc' | 'link'
  | 'spark' | 'flag' | 'users' | 'cloud' | 'refresh' | 'layers' | 'chevron' | 'target'
  | 'report' | 'flow' | 'stack';

/* path-only, 统一 24 网格 —— 加新图标只要往这里补一条 */
const GLYPH_PATHS: Record<GlyphName, React.ReactNode> = {
  check:    <path d="m4.5 12.5 4.5 4.5L19.5 6.5" />,
  alert:    <><path d="M12 4.5 21 20H3z" /><path d="M12 10v4.4" /><path d="M12 17.3h.01" /></>,
  cross:    <path d="M6 6l12 12M18 6 6 18" />,
  info:     <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8h.01" /></>,
  bug:      <><rect x="7" y="7.5" width="10" height="11" rx="5" /><path d="M9 6 8 4M15 6l1-2M7 11H3.5M20.5 11H17M7 15.5H4M20 15.5h-3M12 8.5v9" /></>,
  shield:   <><path d="M12 3.5 20 6.5v5.2c0 4.4-3.1 7.6-8 9.3-4.9-1.7-8-4.9-8-9.3V6.5z" /><path d="m8.8 12 2.2 2.2 4.2-4.4" /></>,
  bolt:     <path d="M13.4 2.5 5 13.4h5.6L9.9 21.5 18.7 10h-5.9z" />,
  network:  <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5S14.4 18.6 12 20.5c-2.4-1.9-3.6-5.3-3.6-8.5S9.6 5.9 12 3.5z" /></>,
  database: <><ellipse cx="12" cy="6" rx="7.5" ry="3" /><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" /><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" /></>,
  code:     <path d="m8.5 8-5 4 5 4M15.5 8l5 4-5 4M13.5 4.5 10.5 19.5" />,
  file:     <><path d="M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z" /><path d="M14 3.5V8h4.5" /></>,
  test:     <><path d="M9.5 3.5v6L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3l-4.7-8.5v-6" /><path d="M8.5 3.5h7M7.6 14h8.8" /></>,
  clock:    <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.2V12l3.2 2" /></>,
  git:      <><circle cx="7" cy="5.5" r="2.5" /><circle cx="7" cy="18.5" r="2.5" /><circle cx="17" cy="12" r="2.5" /><path d="M7 8v8M9.4 6.8c3.4.3 5.2 1.6 5.4 4.4M14.8 13.4c-.4 2.6-2.2 3.8-5.4 4" /></>,
  lock:     <><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" /></>,
  rocket:   <><path d="M13.5 3.5c3.6 1.4 6 4.6 7 9.5-4.5 3.6-8.3 4.6-11.4 3.1" /><path d="M9.1 16.1 6.4 13.4c-1.3-2.9-.4-6.7 2.6-9.9" /><circle cx="14" cy="10" r="1.8" /><path d="M6.5 17.5 3.5 20.5" /></>,
  search:   <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  eye:      <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  wrench:   <path d="M20 5.5a5 5 0 0 1-6.6 6.3L6 19.2a2.1 2.1 0 0 1-3-3l7.4-7.4A5 5 0 0 1 16.7 2.2l-3.2 3.2 1.6 3.3 3.3 1.6z" />,
  package:  <><path d="M20.5 7.8 12 3.2 3.5 7.8v8.4L12 20.8l8.5-4.6z" /><path d="m3.5 7.8 8.5 4.6 8.5-4.6M12 20.8v-8.4" /></>,
  terminal: <><rect x="2.5" y="4.5" width="19" height="15" rx="2" /><path d="m6.5 9.5 3 2.8-3 2.8M13 15.5h4.5" /></>,
  chart:    <path d="M3.5 20.5h17M7 17V10M12 17V4.5M17 17v-5" />,
  doc:      <><path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z" /><path d="M14 3.5V8h4.5M8.5 12.5h7M8.5 16h5" /></>,
  link:     <><path d="M10 13.8a3.6 3.6 0 0 0 5.3.4l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1l-1.5 1.5" /><path d="M14 10.2a3.6 3.6 0 0 0-5.3-.4l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1.5-1.5" /></>,
  spark:    <path d="m12 3 1.9 5.4L19.5 10l-5.6 1.6L12 17l-1.9-5.4L4.5 10l5.6-1.6z" />,
  flag:     <><path d="M5.5 21V3.8" /><path d="M5.5 4.6h11l-1.8 3.6 1.8 3.6h-11" /></>,
  users:    <><circle cx="9" cy="8" r="3.3" /><path d="M2.8 19.5c.4-3.3 3-5.4 6.2-5.4s5.8 2.1 6.2 5.4" /><path d="M16 5.2a3.3 3.3 0 0 1 0 6.4M17.4 14.6c2.1.7 3.5 2.4 3.8 4.9" /></>,
  cloud:    <path d="M17.2 19a4.4 4.4 0 0 0 .7-8.7A6.6 6.6 0 0 0 5.9 12 4.1 4.1 0 0 0 6.5 19z" />,
  refresh:  <><path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20.5 3.5V9h-5.4" /></>,
  layers:   <><path d="m12 3 8.5 4.6L12 12.2 3.5 7.6z" /><path d="m3.5 12 8.5 4.6 8.5-4.6M3.5 16.4 12 21l8.5-4.6" /></>,
  chevron:  <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  target:   <><circle cx="12" cy="12" r="8.4" /><circle cx="12" cy="12" r="4.2" /><circle cx="12" cy="12" r="0.6" fill="currentColor" /></>,
  report:   <><path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V7.5z" /><path d="M13.5 3.5v4h4.5" /><path d="M9 17v-3.4M12 17v-5.6M15 17v-2.2" /></>,
  flow:     <><rect x="3" y="3.5" width="7" height="5" rx="1.4" /><rect x="14" y="15.5" width="7" height="5" rx="1.4" /><rect x="3" y="15.5" width="7" height="5" rx="1.4" /><path d="M6.5 8.5V15.5M10 18h4M17.5 15.5V12H6.5" /></>,
  stack:    <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
};

export const NGlyph: React.FC<{ name: GlyphName; size?: number; className?: string; strokeWidth?: number }> = ({
  name, size = 14, className, strokeWidth = 1.5,
}) => (
  <svg
    className={className}
    viewBox="0 0 24 24" width={size} height={size}
    fill="none" stroke="currentColor" strokeWidth={strokeWidth}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
  >
    {GLYPH_PATHS[name] ?? GLYPH_PATHS.chevron}
  </svg>
);

/* 文本 → 图标. 顺序即优先级: 越具体越靠前 (先判"失败/风险"再判领域词).
 * 中英双语都覆盖 —— 模型两种语言都写。 */
const GLYPH_RULES: Array<[RegExp, GlyphName]> = [
  [/被阻塞|阻塞|blocked|无法|不可用|失败|failed|fail\b|崩溃|crash/i, 'cross'],
  [/风险|遗留|待办|todo|未验证|未覆盖|pending|后续|follow-?up/i, 'flag'],
  [/警告|注意|需确认|需要确认|warn|caution|歧义/i, 'alert'],
  [/通过|完成|已修|修复|fixed|passed|pass\b|done|ok\b|绿了/i, 'check'],
  [/安全|鉴权|认证|权限|密钥|token|secret|auth|加密|漏洞|越权/i, 'shield'],
  [/缺陷|bug|错误|异常|报错|error|回归/i, 'bug'],
  [/性能|耗时|延迟|慢|吞吐|latency|perf|timeout|超时|卡顿/i, 'bolt'],
  [/网络|请求|接口|反代|代理|proxy|端点|endpoint|http|api\b|路由/i, 'network'],
  [/数据库|建表|迁移|migration|sql|sqlite|索引|db\b/i, 'database'],
  [/测试|用例|断言|覆盖率|test|spec|e2e|assert/i, 'test'],
  [/文档|说明|readme|changelog|doc\b/i, 'doc'],
  [/部署|发布|上线|release|打包|构建|build|ci\b/i, 'rocket'],
  [/依赖|版本|包|npm|pnpm|package|升级/i, 'package'],
  [/命令|脚本|终端|shell|bash|复跑|复现/i, 'terminal'],
  [/配置|参数|开关|默认值|config|flag位|env\b/i, 'wrench'],
  [/缓存|存储|落盘|cache|storage/i, 'layers'],
  [/日志|监控|指标|埋点|metric|log\b/i, 'chart'],
  [/账号|用户|租户|user|account/i, 'users'],
  [/云|服务端|server|cloud|网关|gateway/i, 'cloud'],
  [/重试|轮换|刷新|retry|refresh|rotate/i, 'refresh'],
  [/git|分支|提交|commit|branch|pr\b/i, 'git'],
  [/审查|排查|定位|分析|调研|audit|review|检查/i, 'search'],
  [/代码|函数|重构|实现|refactor|模块|类\b/i, 'code'],
  [/耗时|时间|时长|duration|时刻/i, 'clock'],
  [/目标|结论|方案|决定|拍板/i, 'target'],
];

export function classifyGlyph(text: string, fallback: GlyphName = 'chevron'): GlyphName {
  const t = String(text ?? '');
  if (!t) return fallback;
  for (const [re, name] of GLYPH_RULES) if (re.test(t)) return name;
  return fallback;
}

/** tone → glyph, 用于状态位 */
export const TONE_GLYPH: Record<Tone, GlyphName> = { good: 'check', warn: 'alert', bad: 'cross', info: 'info' };


/** 环: 右上角开口约 60°, 缺口正好让笔画穿出去 */
const SEAL_RING = 'M19.1 7.2A8.4 8.4 0 1 1 16.4 4.3';

const SEAL_STROKE: Record<Tone, string> = {
  /* 勾的收笔冲出环外 —— 从缺口穿出, 一笔写成 */
  good: 'M7.9 12.3l2.9 3.1 8.6-9.4',
  /* 叉的两笔都略微出头, 不是规规矩矩的 X */
  bad: 'M8.2 8.2l7.9 7.9M16.4 7.9 7.9 16.4',
  /* 叹号: 竖笔短促, 点单独一笔 */
  warn: 'M12 7.6v4.9M12 15.9h.01',
  info: 'M12 11.2v5M12 8.1h.01',
};

export const NStatusSeal: React.FC<{ tone: Tone; size?: number }> = ({ tone, size = 15 }) => (
  <svg
    className="nrpt__seal"
    width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor"
    strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={SEAL_RING} strokeWidth={1.5} opacity={0.55} />
    <path d={SEAL_STROKE[tone]} strokeWidth={2.1} />
  </svg>
);

/** 卡片统一头部 — 左侧 mark (圆角方块 + 图标) + 标题/副标题, 右侧插槽 */
export const NCardHead: React.FC<{
  glyph: GlyphName;
  title: string;
  subtitle?: React.ReactNode;
  tone?: Tone;
  right?: React.ReactNode;
}> = ({ glyph, title, subtitle, tone = 'info', right }) => (
  <div className="nhead">
    <span className={`nhead__mark is-${tone}`} aria-hidden><NGlyph name={glyph} size={15} /></span>
    <div className="nhead__text">
      <div className="nhead__title">{title}</div>
      {subtitle ? <div className="nhead__sub">{subtitle}</div> : null}
    </div>
    {right ? <div className="nhead__right">{right}</div> : null}
  </div>
);

/** "4/11" · "83%" · "18 FAIL" — 能解析出比例就返回 0..1, 否则 null (用于给数字配可视化) */
export function ratioOf(value: unknown): number | null {
  const s = String(value ?? '').trim();
  const frac = /^([+-]?[\d.]+)\s*\/\s*([\d.]+)$/.exec(s);
  if (frac) {
    const a = parseFloat(frac[1]); const b = parseFloat(frac[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) return Math.max(0, Math.min(1, a / b));
  }
  const pct = /^([+-]?[\d.]+)\s*%$/.exec(s);
  if (pct) {
    const n = parseFloat(pct[1]);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n / 100));
  }
  return null;
}

/** 细进度条 — 卡片里所有"比例"共用一根, 不再各画各的 */
export const NBar: React.FC<{ ratio: number; tone?: Tone }> = ({ ratio, tone = 'info' }) => (
  <span className={`nbar is-${tone}`} aria-hidden>
    <i className="nbar__fill" style={{ width: `${Math.max(2, Math.min(100, ratio * 100))}%` }} />
  </span>
);
