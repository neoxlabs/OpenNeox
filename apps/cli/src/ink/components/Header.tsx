import React from 'react';
import { Box, Text, useStdout } from '../../../vendor/ink/src/index.js';
import { getDisplayWidth, getLanguage } from '../../i18n/index.js';
import { NeoxTheme } from '../theme.js';
import { getHeroRecentSessions, getHeroNotice, getHeroUsage, getGitBranch } from '../brand/heroData.js';
import { supportsUnicode, colorLevel } from '../brand/terminalCaps.js';

export interface HeaderProps {
  version: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  workDir: string;
  /** Account 一行展示, e.g. 'you@example.com · Max' / '匿名 · BYOK' / '未登录'. 不传走 '—'. */
  account?: string;
  /** Status color: configured (green) or unavailable (gray). */
  accountTone?: 'cyan' | 'green' | 'gray';
  /** resize 重吐时显式传入宽度 (避免与 useStdout context 更新竞态); 不传走 useStdout */
  forceColumns?: number;
  /** resize 重吐时显式传入行数; 不传走 process.stdout.rows */
  forceRows?: number;
  /** resize 重吐专用: 只渲一行紧凑 header */
  slim?: boolean;
}

function truncateToWidth(str: string, maxWidth: number): string {
  if (getDisplayWidth(str) <= maxWidth) return str;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = getDisplayWidth(ch);
    if (w + cw > maxWidth - 1) break; // 留 1 列给 …
    out += ch;
    w += cw;
  }
  return out + '…';
}

/* 路径截断必须**保尾** —— 有用的是项目名, 不是 /private/tmp/... 那截前缀。 */
export function truncatePathTail(path: string, maxLen = 45): string {
  if (path.length <= maxLen) return path;
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return '…' + path.slice(-(maxLen - 1));
  const tail = '…/' + parts.slice(-2).join('/');
  return tail.length <= maxLen ? tail : '…' + tail.slice(-(maxLen - 1));
}

/** provider 显示名去掉协议后缀: "relay-a · Grok (OpenAI (Chat))" → "relay-a · Grok" (协议是实现细节) */
export function providerLabel(provider: string): string {
  let p = provider.trim();
  for (let i = 0; i < 3; i++) {
    const next = p.replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, '');
    if (next === p) break;
    p = next;
  }
  return p || provider;
}

/** 账号只露套餐 —— 邮箱会出现在每一张截图、每一次屏幕共享里 */
export function accountLabel(account?: string): string {
  if (!account || account === '—') return '';
  const parts = account.split(/\s+·\s+/);
  if (parts.length >= 2 && parts[0]!.includes('@')) return parts.slice(1).join(' · ');
  return account;
}

function homeRelative(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/* ─── 品牌渐变 ─────────────────────────────────────────────── */
const hexToRgb = (h: string) => (h.replace('#', '').match(/\w\w/g) || ['0', '0', '0']).map(x => parseInt(x, 16));
const rgbToHex = (c: number[]) => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
/** t ∈ [0,1] 沿 mark 的紫→蓝渐变取色; shade<1 压暗 (字标的投影面)。
 *  16 色终端渐变会被量化成几块跳变的色块 → 那一档正面一律品红、投影暗品红 (见 terminalCaps) */
function gradientAt(t: number, shade = 1): string {
  if (colorLevel() <= 1) return shade < 1 ? 'magenta' : 'magentaBright';
  const g = NeoxTheme.logoGradient;
  const x = Math.max(0, Math.min(1, t)) * (g.length - 1);
  const i = Math.min(g.length - 2, Math.floor(x));
  const a = hexToRgb(g[i]!), b = hexToRgb(g[i + 1]!);
  return rgbToHex(a.map((v, k) => (v + (b[k]! - v) * (x - i)) * shade));
}

/** 品牌符: 实心 ◆ (slim 单行用); 画不了 Unicode 的终端用 * */
const Mark: React.FC = () => <Text color={gradientAt(0)} bold>{supportsUnicode() ? '◆' : '*'}</Text>;

/* ─── 字标 NEOX: ANSI Shadow 字形 —— 只用整块 █ 和双线框字符 ──────────────
 * 不用半块 ▀▄: Termius 等终端里半块和整块的字形宽度对不齐, 拼出来是一道道竖缝 (上一版的"丑")。
 * █ 是正面, 取横向紫→蓝渐变; ╗║╝═ 是投影, 同色压暗 —— 有立体和分量, 不依赖背景色。 */
const WORDMARK_ROWS: string[] = [
  '███╗   ██╗███████╗ ██████╗ ██╗  ██╗',
  '████╗  ██║██╔════╝██╔═══██╗╚██╗██╔╝',
  '██╔██╗ ██║█████╗  ██║   ██║ ╚███╔╝ ',
  '██║╚██╗██║██╔══╝  ██║   ██║ ██╔██╗ ',
  '██║ ╚████║███████╗╚██████╔╝██╔╝ ██╗',
  '╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝',
];
/* 画不了 Unicode 的终端 (老 Windows 控制台 / Linux 虚拟控制台): figlet standard 字形, 只用 ASCII。
 * 投影面 (_ 和 /\) 按同样规则压暗, 竖笔 | 当正面 */
const WORDMARK_ASCII: string[] = [
  ' _   _  _____   ___  __  __',
  '| \\ | || ____| / _ \\ \\ \\/ /',
  '|  \\| ||  _|  | | | | \\  / ',
  '| |\\  || |___ | |_| | /  \\ ',
  '|_| \\_||_____| \\___/ /_/\\_\\',
];
const wordmarkRows = () => (supportsUnicode() ? WORDMARK_ROWS : WORDMARK_ASCII);
const wordmarkWidth = () => wordmarkRows()[0]!.length;

const Wordmark: React.FC = () => {
  const rows = wordmarkRows();
  const W = rows[0]!.length;
  const face = supportsUnicode() ? (ch: string) => ch === '█' : (ch: string) => ch === '|';
  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map((row, y) => {
        /* 同色同类的相邻字符并成一段, 一行十几个 <Text> 而不是三十几个 */
        const runs: Array<{ s: string; c?: string }> = [];
        [...row].forEach((ch, x) => {
          const c = ch === ' ' ? undefined : gradientAt(x / (W - 1), face(ch) ? 1 : 0.45);
          const last = runs[runs.length - 1];
          if (last && last.c === c) last.s += ch;
          else runs.push({ s: ch, c });
        });
        return <Text key={y}>{runs.map((r, i) => r.c ? <Text key={i} color={r.c}>{r.s}</Text> : r.s)}</Text>;
      })}
    </Box>
  );
};

const isZh = () => { try { return getLanguage() === 'zh'; } catch { return false; } };

/** 卡片上边框, 标题嵌在线里: ╭─ ◆ Neox  v3.4.9 ──────────╮ —— 总宽严格等于 width */
const TitledTop: React.FC<{ width: number; version: string }> = ({ width, version }) => {
  const b = NeoxTheme.border.primary;
  const u = supportsUnicode();
  const ver = ` v${version} `;
  const used = 2 /* ╭─ */ + 3 /* ' ◆ ' */ + 5 /* 'Neox ' */ + getDisplayWidth(ver) + 1 /* ╮ */;
  return (
    <Text>
      <Text color={b}>{u ? '╭─' : '+-'}</Text>
      <Text color={gradientAt(0)} bold>{u ? ' ◆ ' : ' * '}</Text>
      <Text bold>{'Neox '}</Text>
      <Text color={NeoxTheme.text.dim}>{ver}</Text>
      <Text color={b}>{(u ? '─' : '-').repeat(Math.max(1, width - used))}{u ? '╮' : '+'}</Text>
    </Text>
  );
};

/** 额度条: 本月 ━━━━━━──────── 11% —— 70% 起变黄, 90% 起变红 */
const UsageBar: React.FC<{ label: string; percent: number; barW: number }> = ({ label, percent, barW }) => {
  const u = supportsUnicode();
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * barW);
  const color = p >= 90 ? NeoxTheme.functional.error : p >= 70 ? NeoxTheme.functional.warning : gradientAt(0.35);
  return (
    <Text>
      <Text color={NeoxTheme.text.secondary}>{label + ' '}</Text>
      <Text color={color}>{(u ? '━' : '#').repeat(filled)}</Text>
      <Text color={NeoxTheme.border.primary}>{(u ? '─' : '-').repeat(barW - filled)}</Text>
      <Text>{` ${p}%`}</Text>
    </Text>
  );
};

/** 账号串 ("a@b.com  ·  Max" / "匿名 (BYOK)" / "未登录 · /login" …) → 显示用的两段: 主值 + 灰色补充 */
function accountParts(account?: string): { main: string; sub: string; signedIn: boolean } {
  const zh = isZh();
  if (!account || account === '—') return { main: '—', sub: '', signedIn: false };
  const parts = account.split(/\s+·\s+/);
  if (parts[0]!.includes('@')) return { main: parts[0]!, sub: parts.slice(1).join(' · '), signedIn: true };
  /* 公开版没有登录这回事 ("本地 BYOK") —— 别让它去 /login */
  if (/^本地\s*BYOK$/i.test(account)) return { main: zh ? '本地' : 'Local', sub: zh ? 'BYOK 自带 Key' : 'BYOK', signedIn: false };
  if (/BYOK/i.test(account)) return { main: zh ? '未登录' : 'Not signed in', sub: zh ? 'BYOK 自带 Key · /login 登录' : 'BYOK · /login to sign in', signedIn: false };
  return { main: parts[0]!, sub: parts.slice(1).join(' · '), signedIn: false };
}

/** 目录一行: ~/AI/ppt · main (有 git 分支就带上) */
function dirParts(workDir: string, maxW: number): { dir: string; branch: string } {
  const branch = getGitBranch(workDir) || '';
  const branchW = branch ? getDisplayWidth(branch) + 3 : 0;
  return { dir: truncatePathTail(homeRelative(workDir), Math.max(12, maxW - branchW)), branch };
}

const USAGE_BAR_W = 14;

/** 键值表的自然宽度 (标签列 + 最长的值) —— 卡宽按它收, 右边不留空。wide = 三栏布局 (最近会话另起一栏) */
function gridNaturalWidth(props: HeaderProps, wide: boolean): number {
  const labelW = (isZh() ? 4 : 7) + 2;
  const acc = accountParts(props.account);
  const usage = getHeroUsage();
  const context = providerLabel(props.provider);
  const d = dirParts(props.workDir, 44);
  const vals = [
    [props.model || '—', props.reasoningEffort].filter(Boolean).join(' · '),
    [acc.main, acc.sub, !wide && usage ? `${usage.label} ${usage.percent}%` : ''].filter(Boolean).join(' · '),
    context,
    [d.dir, d.branch].filter(Boolean).join(' · '),
    ...(wide
      ? (usage ? [`${usage.label} ${'-'.repeat(USAGE_BAR_W)} 100%`] : [])
      : getHeroRecentSessions().slice(0, 2).map(r => `${r.title} · ${r.ago}`)),
  ];
  return labelW + Math.max(...vals.map(v => getDisplayWidth(v)));
}

const InfoGrid: React.FC<{ props: HeaderProps; width: number; wide?: boolean }> = ({ props, width, wide }) => {
  const zh = isZh();
  const L = zh
    ? { model: '模型', account: '账号', usage: '额度', service: '服务', dir: '目录', recent: '最近', none: '还没有会话' }
    : { model: 'Model', account: 'Account', usage: 'Usage', service: 'Service', dir: 'Dir', recent: 'Recent', none: 'No sessions yet' };
  const labelW = Math.max(...[L.model, L.account, L.usage, L.service, L.dir, L.recent].map(getDisplayWidth)) + 2;
  const valW = Math.max(8, width - labelW);
  const context = providerLabel(props.provider);
  const acc = accountParts(props.account);
  const usage = getHeroUsage();
  /* 窄一档没有额度那一行, 把 "本月 11%" 并进账号行的灰字里 —— 放得下才并, 放不下宁可不显示也别把套餐截成 "Max …" */
  const usageTail = !wide && usage ? `${usage.label} ${usage.percent}%` : '';
  const accSub = [acc.sub, usageTail && getDisplayWidth(`${acc.main} · ${acc.sub} · ${usageTail}`) <= valW ? usageTail : '']
    .filter(Boolean).join(' · ');
  const d = dirParts(props.workDir, valW);
  const model = props.model || '—';
  const effortW = props.reasoningEffort ? getDisplayWidth(props.reasoningEffort) + 3 : 0;

  const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <GridRow label={label} labelW={labelW} valW={valW}>{children}</GridRow>
  );

  return (
    <Box flexDirection="column" width={width}>
      <Row label={L.model}>
        <Text bold>{truncateToWidth(model, Math.max(6, valW - effortW))}</Text>
        {props.reasoningEffort ? <Text color={NeoxTheme.text.dim}>{' · ' + props.reasoningEffort}</Text> : null}
      </Row>
      <Row label={L.account}>
        <Text color={acc.signedIn ? undefined : NeoxTheme.text.secondary}>{truncateToWidth(acc.main, valW)}</Text>
        {accSub ? <Text color={NeoxTheme.text.dim}>{' · ' + accSub}</Text> : null}
      </Row>
      {wide && usage ? <Row label={L.usage}><UsageBar label={usage.label} percent={usage.percent} barW={USAGE_BAR_W} /></Row> : null}
      <Row label={L.service}><Text>{truncateToWidth(context || '—', valW)}</Text></Row>
      <Row label={L.dir}>
        <Text>{d.dir}</Text>
        {d.branch ? <Text color={NeoxTheme.text.dim}>{' · ' + d.branch}</Text> : null}
      </Row>
      {wide ? null : <InfoRecent L={L} labelW={labelW} valW={valW} width={width} />}
    </Box>
  );
};

const GridRow: React.FC<{ label: string; labelW: number; valW: number; children: React.ReactNode }> = ({ label, labelW, valW, children }) => (
  <Box>
    <Box width={labelW} flexShrink={0}><Text color={NeoxTheme.text.dim}>{label}</Text></Box>
    <Box width={valW}><Text wrap="truncate-end">{children}</Text></Box>
  </Box>
);

/** 窄一档: 表下半截 = 分割线 + 最近 2 条 */
const InfoRecent: React.FC<{ L: { recent: string; none: string }; labelW: number; valW: number; width: number }> = ({ L, labelW, valW, width }) => {
  const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <GridRow label={label} labelW={labelW} valW={valW}>{children}</GridRow>
  );
  const recent = getHeroRecentSessions().slice(0, 2);
  return (
    <Box flexDirection="column">
      <Text color={NeoxTheme.border.primary}>{(supportsUnicode() ? '─' : '-').repeat(width)}</Text>
      {recent.length > 0 ? recent.map((r, i) => (
        <Row key={i} label={i === 0 ? L.recent : ''}>
          <Text>{truncateToWidth(r.title, Math.max(4, valW - getDisplayWidth(r.ago) - 3))}</Text>
          <Text color={NeoxTheme.text.dim}>{' · ' + r.ago}</Text>
        </Row>
      )) : <Row label={L.recent}><Text color={NeoxTheme.text.dim}>{L.none}</Text></Row>}
      {recent.length < 2 ? <Text> </Text> : null}
    </Box>
  );
};

/** 宽屏第三栏: 最近会话 4 条, 标题左对齐、时间右对齐, 底下一行 /resume */
const RecentColumn: React.FC<{ width: number }> = ({ width }) => {
  const zh = isZh();
  const recent = getHeroRecentSessions().slice(0, 4);
  return (
    <Box flexDirection="column" width={width}>
      <Text color={NeoxTheme.text.dim}>{zh ? '最近会话' : 'Recent sessions'}</Text>
      {recent.map((r, i) => {
        const agoW = getDisplayWidth(r.ago);
        const title = truncateToWidth(r.title, Math.max(4, width - agoW - 2));
        const pad = Math.max(2, width - getDisplayWidth(title) - agoW);
        return (
          <Text key={i}>
            <Text>{title}</Text>
            <Text color={NeoxTheme.text.dim}>{' '.repeat(pad) + r.ago}</Text>
          </Text>
        );
      })}
      <Text color={NeoxTheme.text.dim}>{zh ? '/resume 看全部' : '/resume for all'}</Text>
    </Box>
  );
};

/** 公告位: 卡片正下方一行, 有未读公告才出现 (不常驻占地方)。颜色按严重程度: 普通=品牌紫 / 注意=黄 / 紧急=红 */
const Notice: React.FC<{ width: number; indent: number }> = ({ width, indent }) => {
  const n = getHeroNotice();
  if (!n) return null;
  const color = n.severity === 'critical' ? NeoxTheme.functional.error
    : n.severity === 'warn' ? NeoxTheme.functional.warning : gradientAt(0.2);
  const label = isZh() ? '公告' : 'Notice';
  const link = n.link ? `  ${n.link}` : '';
  const titleW = Math.max(8, width - getDisplayWidth(label) - 3 - getDisplayWidth(link));
  return (
    <Box marginLeft={indent}>
      <Text wrap="truncate-end">
        <Text color={color} bold>{'● ' + label}</Text>
        <Text>{'  ' + truncateToWidth(n.title, titleW)}</Text>
        {link ? <Text color={NeoxTheme.text.dim}>{link}</Text> : null}
      </Text>
    </Box>
  );
};

/** 卡片下方一行快捷提示 —— 只写真有的功能; 和卡片内容同一条左边线 */
const Tips: React.FC<{ width: number }> = ({ width }) => {
  const items: Array<[string, string]> = isZh()
    ? [['/', '命令'], ['/resume', '接着聊'], ['ctrl+o', '完整记录'], ['esc', '中断']]
    : [['/', 'commands'], ['/resume', 'continue'], ['ctrl+o', 'transcript'], ['esc', 'interrupt']];
  /* 一行放得下就一行 (· 分隔); 放不下 (窄屏叠放时卡很窄) 按项折行, 不超出卡的宽度 */
  const oneLine = items.reduce((n, [k, v]) => n + getDisplayWidth(`${k} ${v}`), 0) + 5 * (items.length - 1) <= width;
  if (oneLine) {
    return (
      <Text>
        {items.map(([k, v], i) => (
          <Text key={k}>
            {i > 0 ? <Text color={NeoxTheme.text.dim}>{'  ·  '}</Text> : null}
            <Text color={NeoxTheme.text.secondary}>{k}</Text>
            <Text color={NeoxTheme.text.dim}>{' ' + v}</Text>
          </Text>
        ))}
      </Text>
    );
  }
  return (
    <Box flexWrap="wrap" width={width} columnGap={3}>
      {items.map(([k, v]) => (
        <Text key={k}>
          <Text color={NeoxTheme.text.secondary}>{k}</Text>
          <Text color={NeoxTheme.text.dim}>{' ' + v}</Text>
        </Text>
      ))}
    </Box>
  );
};

// ════════════════════════════════════════════════════════════════════
//
//   ╭─ ◆ Neox  v3.4.9 ───────────────────────────────────────────────────────────╮
//   │                                                                            │
//   │  ███╗   ██╗███████╗ ██████╗ ██╗  ██╗   │   模型  deepseek-v4.1-flash · medium   │
//   │  ████╗  ██║██╔════╝██╔═══██╗╚██╗██╔╝   │   服务  Neox Cloud · Max               │
//   │  ██╔██╗ ██║█████╗  ██║   ██║ ╚███╔╝    │   目录  ~/AI/ppt                       │
//   │  ██║╚██╗██║██╔══╝  ██║   ██║ ██╔██╗    │   ──────────────────────────────────   │
//   │  ██║ ╚████║███████╗╚██████╔╝██╔╝ ██╗   │   最近  打招呼 · 1 小时前              │
//   │  ╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝   │         总结 math.js 内容 · 1 小时前   │
//   │                                                                            │
//   ╰────────────────────────────────────────────────────────────────────────────╯
//     /  命令  ·  /resume 接着聊  ·  ctrl+o 完整记录  ·  esc 中断
//
// 历次被否: 半块像素字 (Termius 竖缝) / ◆+细线 (太简单) / 满宽双栏面板 (大而空) / 无框字标+散排信息 (没对齐、没边框、乱)。
// 规矩: 卡宽 = 内容宽 (不撑满屏, 不留大空); 信息是标签列+值列的表, 行行对齐; 标题嵌上边框;
// 快捷提示在卡外、与卡内内容同一左边线。窄屏字标和表上下叠, 卡宽跟着收。
// ════════════════════════════════════════════════════════════════════
const MAX_CARD_W = 150;
const RECENT_MIN_W = 34;

/** 竖分割线 + 左侧留白 (│ 左右各 3 空)。三栏时给定高 —— 两栏内容行数不同, 不定高两条竖线一长一短、上下错开 */
const Divided: React.FC<{ children: React.ReactNode; height?: number }> = ({ children, height }) => (
  <Box marginLeft={3} paddingLeft={3} borderStyle={supportsUnicode() ? 'single' : 'classic'} borderColor={NeoxTheme.border.primary}
    borderTop={false} borderRight={false} borderBottom={false} height={height}>
    {children}
  </Box>
);

/** 最近会话一栏的自然宽度: 最长标题 + 4 空 + 最长时间 (标题太长的按 40 列截) */
function recentNaturalWidth(): number {
  const recent = getHeroRecentSessions().slice(0, 4);
  const titleW = Math.min(40, Math.max(0, ...recent.map(r => getDisplayWidth(r.title))));
  const agoW = Math.max(0, ...recent.map(r => getDisplayWidth(r.ago)));
  return Math.max(RECENT_MIN_W, titleW + 4 + agoW);
}

export const Header: React.FC<HeaderProps> = (props) => {
  const { columns = 80 } = useStdout();
  const width = props.forceColumns ?? columns ?? 80;
  const rows = props.forceRows ?? process.stdout.rows ?? 24;
  const WM = wordmarkWidth();
  /* GAP = 字标与表之间: 3 空 + │ 竖分割线 + 3 空 */
  const PAD = 2, GAP = 7;
  /* 太矮的终端 (<18 行) 整张卡占掉一大半屏, 给单行 */
  if (props.slim || rows < 18 || width < WM + 2 + PAD * 2 + 1) return <SlimHeader {...props} width={width} />;

  const hasRecent = getHeroRecentSessions().length > 0;
  const wideGridW = Math.min(Math.max(24, gridNaturalWidth(props, true)), 48);
  /* 最近会话栏按内容定宽 (不把终端撑满 —— 满宽的空白就是 "大而空"), 放不下自然宽度才截 */
  const fixedW = 2 + PAD * 2 + WM + GAP + wideGridW + GAP;
  const recentW = Math.min(recentNaturalWidth(), Math.min(width - 1, MAX_CARD_W) - fixedW);
  const wideCardW = fixedW + recentW;
  const wide = hasRecent && recentW >= RECENT_MIN_W;

  const sideBySide = wide || width >= 2 + PAD * 2 + WM + GAP + 30 + 1;
  const natural = Math.max(24, gridNaturalWidth(props, false));
  const gridW = wide ? wideGridW
    : sideBySide
      ? Math.min(natural, 52, width - 1 - 2 - PAD * 2 - WM - GAP)
      : Math.min(natural, 52, width - 1 - 2 - PAD * 2);
  const cardW = wide ? wideCardW
    : sideBySide
      ? 2 + PAD * 2 + WM + GAP + gridW
      : 2 + PAD * 2 + Math.max(WM, gridW);
  return (
    <Box flexDirection="column" marginTop={1}>
      <TitledTop width={cardW} version={props.version} />
      <Box width={cardW} borderStyle={supportsUnicode() ? 'round' : 'classic'} borderColor={NeoxTheme.border.primary} borderTop={false}
        flexDirection={sideBySide ? 'row' : 'column'} alignItems={sideBySide ? 'center' : undefined} paddingX={PAD} paddingY={1}>
        <Wordmark />
        {sideBySide
          ? <Divided height={wide ? wordmarkRows().length : undefined}><InfoGrid props={props} width={gridW} wide={wide} /></Divided>
          : <Box marginTop={1}><InfoGrid props={props} width={gridW} /></Box>}
        {wide ? <Divided height={wordmarkRows().length}><RecentColumn width={recentW} /></Divided> : null}
      </Box>
      <Notice width={cardW - (PAD + 1) * 2} indent={PAD + 1} />
      <Box marginLeft={PAD + 1}><Tips width={cardW - (PAD + 1) * 2} /></Box>
    </Box>
  );
};
// ─── slim / 极窄 / resize 重吐: 单行 — ◆ NEOX  model · provider ──────
const SlimHeader: React.FC<HeaderProps & { width: number }> = (props) => {
  const max = Math.max(8, props.width - 1);
  const prefix = '◆ NEOX  ';
  const modelLine = [props.model || '—', props.reasoningEffort].filter(Boolean).join(' · ');
  const tail = providerLabel(props.provider);
  const budget = Math.max(4, max - getDisplayWidth(prefix));
  const modelShown = truncateToWidth(modelLine, budget);
  const tailBudget = budget - getDisplayWidth(modelShown) - 3;
  const tailShown = tail && tailBudget > 2 ? ' · ' + truncateToWidth(tail, tailBudget) : '';
  return (
    <Box marginBottom={1}>
      <Mark />
      <Text color={gradientAt(0.5)} bold>{' NEOX  '}</Text>
      <Text>{modelShown}</Text>
      {tailShown && <Text color={NeoxTheme.text.dim}>{tailShown}</Text>}
    </Box>
  );
};
