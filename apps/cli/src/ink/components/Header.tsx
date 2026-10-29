import React from 'react';
import { Box, Text, useStdout } from '../../../vendor/ink/src/index.js';
import { getDisplayWidth, getLanguage } from '../../i18n/index.js';
import { NeoxTheme } from '../theme.js';
import { getHeroRecentSessions, getHeroNotice, getHeroUsage, getGitBranch } from '../brand/heroData.js';
import { supportsUnicode, colorLevel } from '../brand/terminalCaps.js';
import { getThemeName } from '../theme.js';

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

/** 卡片框线: 陶土主题用淡陶土色 (全屏只有这一处), 其它配色用普通细线 */
const cardBorder = () => (getThemeName() === 'clay' && colorLevel() >= 2 ? NeoxTheme.clay : NeoxTheme.border.primary);

/** 卡片上边框, 标题嵌在线里: ╭─ ◆ Neox  v3.4.9 ──────────╮ —— 总宽严格等于 width */
const TitledTop: React.FC<{ width: number; version: string }> = ({ width, version }) => {
  const b = cardBorder();
  const u = supportsUnicode();
  const clay = getThemeName() === 'clay';
  const ver = ` v${version} `;
  const name = clay ? 'Neox CLI ' : 'Neox ';
  const lead = clay ? ' ' : u ? ' ◆ ' : ' * ';
  const used = 2 /* ╭─ */ + lead.length + name.length + getDisplayWidth(ver) + 1 /* ╮ */;
  return (
    <Text>
      <Text color={b}>{u ? '╭─' : '+-'}</Text>
      <Text color={gradientAt(0)} bold>{lead}</Text>
      <Text bold>{name}</Text>
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
  if (/^(本地|Local)\s*BYOK$/i.test(account)) return { main: zh ? '本地' : 'Local', sub: zh ? 'BYOK 自带 Key' : 'BYOK', signedIn: false };
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

function heroBits(props: HeaderProps) {
  const T = NeoxTheme;
  const acc = accountParts(props.account);
  const usage = getHeroUsage();
  const plan = acc.signedIn ? acc.sub : acc.main;
  const d = dirParts(props.workDir, 40);
  const service = providerLabel(props.provider) || '';
  const pct = usage ? Math.max(0, Math.min(100, usage.percent)) : 0;
  const barColor = pct >= 90 ? T.functional.error : pct >= 70 ? T.functional.warning : T.brand.blue;
  const filled = Math.round(pct / 10);
  const bar = usage ? (
    <Text>
      <Text color={barColor}>{'▰'.repeat(filled)}</Text><Text color={T.text.faint}>{'▱'.repeat(10 - filled)}</Text>
      <Text color={pct >= 70 ? barColor : T.text.dim}>{` ${pct}%`}</Text>
    </Text>
  ) : null;
  return {
    T, plan, usage, bar, service, recent: getHeroRecentSessions().slice(0, 3),
    model: props.model || '—', effort: props.reasoningEffort,
    dir: d.dir + (d.branch ? ' · ' + d.branch : ''),
  };
}

/** 最近会话压成一行: 最近  标题 10m · 标题 11m · /resume */
const RecentInline: React.FC<{ recent: Array<{ title: string; ago: string }>; max: number }> = ({ recent, max }) => {
  const zh = isZh();
  const T = NeoxTheme;
  if (!recent.length) return <Text color={T.text.faint}>{zh ? '还没有会话' : 'No sessions yet'}</Text>;
  return (
    <Text wrap="truncate-end">
      {recent.slice(0, max).map((r, i) => (
        <Text key={i}>
          {i > 0 ? <Text color={T.text.faint}>{'   '}</Text> : null}
          <Text>{truncateToWidth(r.title, 18)}</Text>
          <Text color={T.text.faint}>{' ' + r.ago}</Text>
        </Text>
      ))}
    </Text>
  );
};

const ClayHeroE: React.FC<HeaderProps & { width: number; wordmark?: boolean }> = (props) => {
  const b = heroBits(props);
  const { T } = b;
  const zh = isZh();
  const L = zh ? { model: '模型', usage: '额度', dir: '目录', recent: '最近' }
    : { model: 'Model', usage: 'Usage', dir: 'Dir', recent: 'Recent' };
  const LW = zh ? 7 : 8;
  /* 带艺术字时右边信息栏窄一些 (艺术字 35 列 + 间距 4) */
  const W = props.wordmark ? Math.min(52, props.width - 8 - WORDMARK_ROWS[0]!.length - 4) : Math.min(76, props.width - 8);
  const Row: React.FC<{ k: string; children: React.ReactNode }> = ({ k, children }) => (
    <Box width={W}>
      <Box width={LW} flexShrink={0}><Text color={T.text.faint}>{k}</Text></Box>
      <Box flexShrink={1}><Text wrap="truncate-end">{children}</Text></Box>
    </Box>
  );
  const rows = (
    <Box flexDirection="column">
      <Row k={L.model}><Text bold>{b.model}</Text>{b.effort ? <Text color={T.text.dim}>{' · ' + b.effort}</Text> : null}{b.service ? <Text color={T.text.dim}>{' · ' + b.service}</Text> : null}</Row>
      {b.usage || b.plan ? (
        <Row k={L.usage}>
          {b.usage ? <Text><Text color={T.text.dim}>{(b.plan ? b.plan + ' · ' : '') + b.usage.label + ' '}</Text>{b.bar}</Text> : <Text color={T.text.dim}>{b.plan}</Text>}
        </Row>
      ) : null}
      <Row k={L.dir}><Text color={T.text.dim}>{b.dir}</Text></Row>
      {b.recent.length ? <Row k={L.recent}><RecentInline recent={b.recent} max={2} /></Row> : null}
    </Box>
  );
  const cardW = W + 6 + (props.wordmark ? WORDMARK_ROWS[0]!.length + 4 : 0);
  return (
    <Box flexDirection="column" marginTop={1}>
      <TitledTop width={cardW} version={props.version} />
      <Box width={cardW} borderStyle="round" borderColor={cardBorder()} borderTop={false} paddingX={2} paddingY={1} flexDirection="column">
        {props.wordmark ? (
          <Box flexDirection="row" alignItems="center">
            <Wordmark />
            <Box marginLeft={4} flexDirection="column">{rows}</Box>
          </Box>
        ) : rows}
      </Box>
    </Box>
  );
};

const ICON_S = 10;
const ICON_MAP = [
  '.LLLLLLLL.',
  'CCCCCCCCCC',
  'CCCCCCCCCC',
  'CCCCBBCCCC',
  'CCCBBBBCCC',
  'CCCBBBBCCC',
  'CCCCBBCCCC',
  'CCCCCCCCCC',
  'CCCCCCCCCC',
  '.DDDDDDDD.',
];
function iconPixel(x: number, y: number): string | null {
  const ch = ICON_MAP[y]?.[x];
  return ch === 'L' ? '#E2B99B' : ch === 'C' ? '#D49A78' : ch === 'D' ? '#C0805E' : ch === 'B' ? NeoxTheme.brand.blue : null;
}
const canDrawIcon = () => supportsUnicode() && colorLevel() >= 2;
const ClayIcon: React.FC = () => (
  <Box flexDirection="column" flexShrink={0}>
    {Array.from({ length: ICON_S / 2 }, (_, r) => (
      <Text key={r}>
        {Array.from({ length: ICON_S }, (_, x) => {
          const t = iconPixel(x, r * 2), b = iconPixel(x, r * 2 + 1);
          if (!t && !b) return <Text key={x}> </Text>;
          if (t && b) return <Text key={x} color={t} backgroundColor={b}>▀</Text>;
          return t ? <Text key={x} color={t}>▀</Text> : <Text key={x} color={b!}>▄</Text>;
        })}
      </Text>
    ))}
  </Box>
);

const EFFORT_ZH: Record<string, string> = { minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极高' };

/* 设计稿的启动框 (陶土稿 v3 · 中档):
 *   ╭─ Neox CLI 3.10.22 ─────────────────────────────────────────────────────╮
 *   │  (图标)   欢迎回来                    │  最近                            │
 *   │           deepseek-v4.1-flash · 高    │  登录页报错排查     12 分钟前     │
 *   │           Max · 5h ▰▰▱▱▱▱▱▱▱▱ 21%     │  上手                            │
 *   │           ~/work/ordersys · main      │  / 命令 · @ 文件 · ctrl+v 贴图     │
 *   ╰────────────────────────────────────────────────────────────────────────╯
 * 右栏放不下就收掉。 */
const ClayHeroCard: React.FC<HeaderProps & { width: number }> = (props) => {
  const b = heroBits(props);
  const { T } = b;
  const zh = isZh();
  const icon = canDrawIcon();
  const effort = b.effort ? (zh ? EFFORT_ZH[b.effort] ?? b.effort : b.effort) : '';
  const modelLine = [b.model, effort && (zh ? `思考 ${effort}` : effort), b.service].filter(Boolean).join(' · ');
  const usageText = b.usage ? `${b.plan ? b.plan + ' · ' : ''}${b.usage.label} ` : b.plan;
  const IW = Math.min(40, Math.max(24, ...[modelLine, b.dir, `${usageText}▰▰▰▰▰▰▰▰▰▰ 100%`].map(s => getDisplayWidth(s))));
  const RW = 30;
  const leftW = 2 + 4 + (icon ? ICON_S + 3 : 0) + IW;
  const withRight = leftW + 7 + RW + 1 <= props.width;
  const cardW = withRight ? leftW + 7 + RW : leftW;
  const tips = zh ? '/ 命令 · @ 文件 · ctrl+v 贴图' : '/ commands · @ files · ctrl+v image';
  const recent = b.recent.slice(0, 2);
  return (
    <Box flexDirection="column" marginTop={1}>
      <TitledTop width={cardW} version={props.version} />
      <Box width={cardW} borderStyle="round" borderColor={cardBorder()} borderTop={false} paddingX={2} paddingY={1} flexDirection="row" alignItems="center">
        {icon ? <Box marginRight={3}><ClayIcon /></Box> : null}
        <Box flexDirection="column" width={IW} flexShrink={0}>
          <Text bold>{zh ? '欢迎回来' : 'Welcome back'}</Text>
          <Text color={T.text.dim} wrap="truncate-end">{modelLine}</Text>
          {b.usage ? <Text wrap="truncate-end"><Text color={T.text.dim}>{usageText}</Text>{b.bar}</Text>
            : b.plan ? <Text color={T.text.dim} wrap="truncate-end">{b.plan}</Text> : null}
          <Text color={T.text.dim} wrap="truncate-end">{b.dir}</Text>
        </Box>
        {withRight ? (
          <Divided>
            <Box flexDirection="column" width={RW}>
              <Text color={T.clay}>{zh ? '最近' : 'Recent'}</Text>
              {recent.length ? recent.map((r, i) => {
                const title = truncateToWidth(r.title, Math.max(4, RW - getDisplayWidth(r.ago) - 2));
                return (
                  <Text key={i}>
                    <Text>{title}</Text>
                    <Text color={T.text.faint}>{' '.repeat(Math.max(2, RW - getDisplayWidth(title) - getDisplayWidth(r.ago))) + r.ago}</Text>
                  </Text>
                );
              }) : <Text color={T.text.faint}>{zh ? '还没有会话' : 'No sessions yet'}</Text>}
              <Text color={T.clay}>{zh ? '上手' : 'Get started'}</Text>
              <Text color={T.text.dim} wrap="truncate-end">{tips}</Text>
            </Box>
          </Divided>
        ) : null}
      </Box>
    </Box>
  );
};

/* 设计稿「小 · 一行」: 窄终端 / 矮终端。◆ neox 3.10.22 · ordersys · main            / 命令 */
const ClaySmallLine: React.FC<HeaderProps & { width: number }> = (props) => {
  const T = NeoxTheme;
  const zh = isZh();
  const d = dirParts(props.workDir, 28);
  const base = d.dir.split('/').filter(Boolean).pop() || d.dir;
  const info = [`v${props.version}`, base, d.branch].filter(Boolean).join(' · ');
  const hint = zh ? '/ 命令' : '/ commands';
  const room = props.width - 1 - getDisplayWidth(`◆ neox ${info}`) - getDisplayWidth(hint) - 2;
  return (
    <Box marginTop={1} marginBottom={1} width={props.width - 1} justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text color={T.clay}>{supportsUnicode() ? '◆' : '*'}</Text>
        <Text bold>{' neox '}</Text>
        <Text color={T.text.dim}>{info}</Text>
      </Text>
      {room > 0 ? <Text color={T.text.faint}>{hint}</Text> : null}
    </Box>
  );
};

export const Header: React.FC<HeaderProps> = (props) => {
  const { columns = 80 } = useStdout();
  const width = props.forceColumns ?? columns ?? 80;
  const rows = props.forceRows ?? process.stdout.rows ?? 24;
  if (!props.slim && getThemeName() === 'clay') {
    const pick = (process.env.NEOX_HERO || '').toLowerCase();
    if (rows < 14 || width < 70) return <ClaySmallLine {...props} width={width} />;
    if (pick === 'card') return <ClayHeroCard {...props} width={width} />;
    if (pick === 'e') return <ClayHeroE {...props} width={width} wordmark={false} />;
    if (width >= 100 && rows >= 16 && supportsUnicode()) return <ClayHeroE {...props} width={width} wordmark />;
    return <ClayHeroCard {...props} width={width} />;
  }
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
      <Box width={cardW} borderStyle={supportsUnicode() ? 'round' : 'classic'} borderColor={cardBorder()} borderTop={false}
        flexDirection={sideBySide ? 'row' : 'column'} alignItems={sideBySide ? 'center' : undefined} paddingX={PAD} paddingY={1}>
        <Wordmark />
        {sideBySide
          ? <Divided height={wide ? wordmarkRows().length : undefined}><InfoGrid props={props} width={gridW} wide={wide} /></Divided>
          : <Box marginTop={1}><InfoGrid props={props} width={gridW} /></Box>}
        {wide ? <Divided height={wordmarkRows().length}><RecentColumn width={recentW} /></Divided> : null}
      </Box>
      <Notice width={cardW - (PAD + 1) * 2} indent={PAD + 1} />
      <Box marginLeft={PAD + 1}><Tips width={Math.max(cardW, width - 1) - (PAD + 1) * 2} /></Box>
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
