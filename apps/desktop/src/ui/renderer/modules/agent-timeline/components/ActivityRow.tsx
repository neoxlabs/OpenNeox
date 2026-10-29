import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconLayers, IconChevronRight, IconAlertCircle } from "../../shell/shellIcons";
import { DotSpinner } from "../../../components/DotSpinner";
import { TodoChecklist, parseTodoLines } from "./TodoChecklist";
import { ToolGlyph, toolGlyphName } from "./ToolGlyph";
import { AgentBrandLogo, rowStepDelegationModel } from "./AgentBrandLogo";
import { splitMcpName, humanizeMcpName } from "../mcpNames";
import { McpServerMark } from "../../../pages/settings/tabs/McpServerMark";
import { SmoothCollapse } from "./SmoothCollapse";
import { useWaitingPhase } from "../../shell/useAgentPhase";
import { useI18n, getGlobalLanguage } from "../../../hooks/useI18n";
import { useCountUp } from "../hooks/useCountUp";
import { useAgentModeVariant } from "../../../hooks/useAgentModeVariant";
import { getStepIconInfo } from "../stepIcons";
import {
  isTimelineBottomFollowIntentActive,
  isTimelineUserScrollGuardActive,
} from "../timelineScrollGuard";
import {
  ACTIVITY_REVEAL_INITIAL_COUNT,
  ACTIVITY_REVEAL_CHUNK_SIZE,
  ACTIVITY_REVEAL_CHUNK_MS,
  activityChildMeta,
  rowBodyWouldBeEmpty,
  activityChildDiffStat,
  activityChildTitle,
  activityDigestSummary,
  activityDigestSegments,
  digestSeparator,
  activityDigestDiffTotal,
  activityFailureCount,
  lastSettledTitle,
  activityDuration,
  activitySummary,
  contentIdsOf,
  currentRunningStartedAtMs,
  currentRunningTitle,
  firstStepOfRow,
  rowHasLiveStep,
  rowHasRunningStep,
  rowHasWaitingAsk,
  rowKeyOf,
  rowStepIconKind,
  rowStepAppIcon,
  rowStepId,
  rowStepIds,
  rowStepContentTypeHint,
  rowStepStatus,
  rowStepToTimelineStep,
  rowStepDuration,
  rowStepIsCompaction,
  rowStepIsTargetContinue,
  rowStepCodeLines,
  thinkingTextOf,
  type Row,
  type RowStep,
  isThinkingRow,
  isPlainHiddenRow,
} from "../timelineRows";
import { currentRunningKey } from "../runningKey";
import { rowHasWideContent } from "../rowWideContent";
import { rowsSeenImages } from "../seenImagesContent";
import { SeenImagesView } from "../cells/SeenImagesView";
import { LAYOUT_ANCHOR_TRANSITION_MS } from "../timelineAnimation";
import {
  debugRowKind,
  getDebugRowLabel,
  isTimelineDebugEnabled,
  logTimelineJank,
} from "../timelineDebug";
import { RowContent } from "./RowContent";
import TimelineStep from "../TimelineStep";
import { shouldShowActivityChildHead } from "./activityChildHead";
import { LiveShimmerText } from "./LiveShimmerText";

const ACTIVITY_CHILD_FRESH_CLASS_CLEAR_MS = 460;

const BRIEF_OUT_MS = 180;
const BRIEF_IN_MS = 240;
/** 同 turn 工具连发时合并轮播, 避免动画堆叠卡顿 */
const BRIEF_SWITCH_DEBOUNCE_MS = 90;

/** 运行中两次上滑之间至少隔这么久; 期间来的切换合并成一次, 滚到最新那句 */
const ROLL_MIN_GAP_MS = 520;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const LiveRollBrief: React.FC<{ text: string; rollKey: string }> = ({ text, rollKey }) => {
  const [lines, setLines] = useState<Array<{ id: number; text: string }>>(() => [{ id: 0, text }]);
  const idRef = useRef(0);
  const keyRef = useRef(rollKey);
  const lastRollAtRef = useRef(0);
  const pendingTimerRef = useRef<number | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  const roll = useCallback(() => {
    pendingTimerRef.current = null;
    lastRollAtRef.current = performance.now();
    idRef.current += 1;
    const next = { id: idRef.current, text: textRef.current };
    /* 上一次还没滚完就只留最后一行再接 —— 永远最多两行在场 */
    setLines((cur) => [cur[cur.length - 1]!, next]);
  }, []);

  useEffect(() => {
    if (rollKey === keyRef.current) {
      /* 同一件事: 原地改字 (计时、计数、半句话往后长) */
      setLines((cur) => {
        const last = cur[cur.length - 1]!;
        if (last.text === text) return cur;
        return [...cur.slice(0, -1), { id: last.id, text }];
      });
      return;
    }
    keyRef.current = rollKey;
    if (prefersReducedMotion()) {
      setLines((cur) => [{ id: cur[cur.length - 1]!.id, text }]);
      return;
    }
    if (pendingTimerRef.current !== null) return; /* 已排队, 到点会取最新文字 */
    const wait = ROLL_MIN_GAP_MS - (performance.now() - lastRollAtRef.current);
    if (wait <= 0) roll();
    else pendingTimerRef.current = window.setTimeout(roll, wait);
  }, [rollKey, text, roll]);

  useEffect(() => () => {
    if (pendingTimerRef.current !== null) window.clearTimeout(pendingTimerRef.current);
  }, []);

  const rolling = lines.length > 1;
  return (
    <span className="atl-activity__brief atl-activity__brief--roll" title={text}>
      <span
        className={`atl-brief-roll${rolling ? " is-rolling" : ""}`}
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          /* 滚完同一帧收掉上一行并把位移归零 —— 新行此时正好在原位, 不会跳 */
          setLines((cur) => (cur.length > 1 ? [cur[cur.length - 1]!] : cur));
        }}
      >
        {lines.map((l) => (
          <span key={l.id} className="atl-brief-roll__line">
            <LiveShimmerText className="atl-activity__brief-text is-live" text={l.text} live />
          </span>
        ))}
      </span>
    </span>
  );
};

export const ActivityBrief: React.FC<{ text: string; live?: boolean; rollKey?: string }> = React.memo(({ text, live, rollKey }) => {
  if (live && rollKey !== undefined) return <LiveRollBrief text={text} rollKey={rollKey} />;
  return <ActivityBriefStatic text={text} live={live} />;
});
ActivityBrief.displayName = "ActivityBrief";

const ActivityBriefStatic: React.FC<{ text: string; live?: boolean }> = React.memo(({ text, live }) => {
  /* 工具名切换: 上滑出 → 下滑入 (恢复丝滑感; 200ms debounce 兼顾连发性能) */
  const [display, setDisplay] = useState(text);
  const [phase, setPhase] = useState<"idle" | "out" | "in">("idle");
  const displayRef = useRef(text);
  const pendingRef = useRef<string | null>(null);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    displayRef.current = display;
  }, [display]);

  useEffect(() => {
    if (text === displayRef.current && pendingRef.current == null) return;

    if (live) {
      const timers0 = timersRef.current;
      for (const id of timers0) window.clearTimeout(id);
      timers0.length = 0;
      pendingRef.current = null;
      setDisplay(text);
      displayRef.current = text;
      setPhase("idle");
      return;
    }

    pendingRef.current = text;
    const timers = timersRef.current;
    for (const id of timers) window.clearTimeout(id);
    timers.length = 0;

    const reduceMotion =
      typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      setDisplay(text);
      pendingRef.current = null;
      setPhase("idle");
      return;
    }

    const run = () => {
      const next = pendingRef.current;
      if (next == null || next === displayRef.current) {
        pendingRef.current = null;
        setPhase("idle");
        return;
      }
      setPhase("out");
      const t1 = window.setTimeout(() => {
        setDisplay(next);
        displayRef.current = next;
        pendingRef.current = null;
        setPhase("in");
        const t2 = window.setTimeout(() => setPhase("idle"), BRIEF_IN_MS);
        timers.push(t2);
      }, BRIEF_OUT_MS);
      timers.push(t1);
    };

    const t0 = window.setTimeout(run, BRIEF_SWITCH_DEBOUNCE_MS);
    timers.push(t0);
    return () => {
      for (const id of timers) window.clearTimeout(id);
      timers.length = 0;
    };
    /* live 也要进依赖: 它被闭包用到了。text 不变而 live 翻转时重跑一次会立刻 early-return, 无副作用。 */
  }, [text, live]);

  const phaseClass =
    phase === "out"
      ? " atl-activity__brief--out"
      : phase === "in"
        ? " atl-activity__brief--in"
        : "";
  /* 外层管 ellipsis/overflow; 内层做文字 shimmer — 避免 transparent clip + overflow:hidden 空头 */
  return (
    <span className={`atl-activity__brief${phaseClass}`} title={text}>
      <LiveShimmerText
        className={`atl-activity__brief-text${live ? ' is-live' : ''}`}
        text={display}
        live={!!live}
      />
    </span>
  );
});
ActivityBriefStatic.displayName = "ActivityBriefStatic";

/* 合并行的改动量徽标。单独成组件是因为 useCountUp 是 hook —— 不能塞在 JSX 的 IIFE 里。
 * 运行中让数字连续爬 (写文件时这一行往往是唯一可见的进度), 结束后吸附到真值。 */
const ActivityDiffBadge: React.FC<{
  activity: Extract<Row, { kind: "activity" }>;
  live: boolean;
}> = ({ activity, live }) => {
  const d = activityDigestDiffTotal(activity);
  const add = useCountUp(d?.add ?? 0, live);
  const del = useCountUp(d?.del ?? 0, live);
  if (!d) return null;
  const a = live ? add : d.add;
  const r = live ? del : d.del;
  /* key 跟着数字走: 值一变节点就重挂, CSS 的翻页动画自然重播一次 —— 这就是"跳跃/翻页"的手感。
     不用 JS 逐帧驱动位移, 交给合成器, 长任务里也不会拖帧。 */
  return (
    <span className={`atl-activity__diff${live ? " is-writing" : ""}`}>
      <span key={`a${a}`} className="atl-activity__diff-add">+{a}</span>
      <span key={`d${r}`} className="atl-activity__diff-del">-{r}</span>
    </span>
  );
};

/* 'patch' 是新 cells 路径的通用壳 (待办 / 工具检索 / 读取都是它), 不能按它默认展开 —— 改动按 diff 统计判 */
const FLAT_OPEN_BY_DEFAULT = new Set(["diff", "edit", "change", "plan", "ask-user", "askUser", "office", "image"]);

/** Code 定版: 这一行能不能走工具行 (分隔线 / 本轮小结 / 系统提示这类不是工具, 照旧走 RowContent) */
export function isFlatToolRow(row: Row): boolean {
  if (row.kind === "cluster" || row.kind === "group") return true;
  if (row.kind !== "single") return false;
  const step = row.step;
  if (rowStepIsCompaction(step) || rowStepIsTargetContinue(step)) return false;
  const hint = rowStepContentTypeHint(step) ?? "";
  return !/summary|system_notice|assistant_text|user/i.test(hint);
}

/* 定版动词 (设计稿用词): 数据层标题照旧 (Work / 右栏 / 测试都在读), 只在这一行换说法 */
const FLAT_VERB_ZH: Record<string, string> = {
  "执行命令": "运行",
  "执行": "运行",
  "写入": "写入",
  "运行命令": "运行",
  "读取文件": "读取",
  "写入文件": "写入",
  "编辑文件": "编辑",
  "修改文件": "编辑",
  "网络搜索": "联网搜索",
  "工具检索": "找工具",
  "列出目录": "列目录",
  "plan": "更新计划",
};
function flatVerb(v: string): string {
  /* 同类合并的「plan ×3」: 次数照留, 只换前面的词 */
  const m = /^(.*?)(\s*×\d+)$/.exec(v);
  if (m) return (FLAT_VERB_ZH[m[1]!] ?? m[1]!) + m[2]!;
  return FLAT_VERB_ZH[v] ?? v;
}
/* 「private/…/ws5/src/util.js」这种中间省略的绝对路径 → 工作区里的相对路径「src/util.js」 */
function flatObject(o: string): string {
  const m = /^\S*…\/[^/\s]+\/(\S.*)$/.exec(o);
  if (m) return m[1]!;
  /* 批量读的进度「3/3」不是对象, 是几个文件 */
  const n = /^(\d+)\/\1$/.exec(o.trim());
  if (n) return _isZhGlobal() ? `${n[1]} 个文件` : `${n[1]} files`;
  return o;
}
function _isZhGlobal(): boolean {
  return getGlobalLanguage() === "zh";
}
/* 「进程已退出 (code 0)」是后台命令的收尾回执: 动词写「后台命令结束」, exit 码进结果 */
function flatTitle(title: string): string {
  const m = /^进程已退出\s*\(code\s*(-?\d+)\)/.exec(title) ?? /^Process exited\s*\(code\s*(-?\d+)\)/i.exec(title);
  return m ? `${_isZhGlobal() ? "后台命令结束" : "Background command ended"} · exit ${m[1]}` : title;
}

/**
 * 连着的几段思考合成一行 —— 模型的一段思考常被流式切成两三截 (「…Keep」/「it brief.」),
 * 一截一行就成了上下两个「思考」。保留第一截那一行, 后面几截的文字挂到它身上一起显示。
 */
function mergeThinkingRuns(rows: Row[]): { rows: Row[]; more: Map<Row, RowStep[]> } {
  const out: Row[] = [];
  const more = new Map<Row, RowStep[]>();
  let head: Row | null = null;
  for (const r of rows) {
    if (r.kind === "single" && isThinkingRow(r)) {
      if (head) { more.get(head)!.push(r.step); continue; }
      head = r;
      more.set(r, []);
      out.push(r);
      continue;
    }
    head = null;
    out.push(r);
  }
  for (const [k, v] of more) if (v.length === 0) more.delete(k);
  return { rows: out, more };
}

export function groupFlatChildren(rows: Row[]): Row[] {
  const out: Row[] = [];
  let buf: Row[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    const inner = buf.flatMap((r) => (r.kind === "activity" ? r.rows : [r]));
    const first = buf[0]!;
    out.push({
      kind: "activity",
      id: `fg-${first.kind === "activity" ? first.id : rowKeyOf(first, out.length)}`,
      rows: inner,
      opCount: inner.filter((r) => !isThinkingRow(r)).length,
      hasActive: buf.some((r) => r.kind === "activity" && r.hasActive),
      inActiveTurn: buf.some((r) => r.kind === "activity" && r.inActiveTurn === true),
    });
    buf = [];
  };
  for (const r of rows) {
    if (r.kind === "activity" || isFlatToolRow(r)) buf.push(r);
    else { flush(); out.push(r); }
  }
  flush();
  return out;
}

const FlatRowHead: React.FC<{
  row: Row;
  title: string;
  meta: string[];
  status: string;
  hasDetails: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** 对象位已经由结果代替 (待办「3 / 7」比「13 项」有用) */
  hideObject?: boolean;
}> = ({ row, title, meta, status, hasDetails, expanded, onToggle, hideObject }) => {
  const { isZh } = useI18n();
  const step = firstStepOfRow(row);
  const { Icon, className } = getStepIconInfo(step ? rowStepIconKind(step) : "task");
  const appIcon = step ? rowStepAppIcon(step) : undefined;
  const thinking = isThinkingRow(row);
  title = flatTitle(title);
  const sep = title.indexOf(" · ");
  /* MCP: 「deepwiki__ask_wiki_question」→ 动词「DeepWiki · 问仓库」, 图标换服务 logo (10-21) */
  const mcp = splitMcpName(sep > 0 ? title.slice(0, sep) : title);
  const verb = mcp ? humanizeMcpName(`${mcp.server}__${mcp.tool}`, isZh) : flatVerb(sep > 0 ? title.slice(0, sep) : title);
  const rawVerb = sep > 0 ? title.slice(0, sep) : title;
  const rawObj = sep > 0 ? title.slice(sep + 3) : "";
  /* 「plan · plan」这种对象跟动词同一个词的, 对象不再写一遍 */
  const obj = thinking || hideObject || rawObj.trim() === rawVerb.trim() ? "" : flatObject(rawObj);
  const dur = step ? rowStepDuration(step) : undefined;
  const durText = dur && !/^0(\.\d+)?m?s$/i.test(dur) ? dur : "";
  const rest = meta.filter((m) => m !== dur);
  const ds = activityChildDiffStat(row);
  const shownVerb = verb === "写入" && ds && ds !== "void" && ds.del === 0 ? "新建" : verb;
  const running = status === "running" || status === "pending";
  const failed = status === "failed";
  /* 跑着: 行尾钴蓝计时每秒跳 (稿: 「运行 npm test … 0:12」) */
  const startedAt = step
    ? ((step as { startedAtMs?: number }).startedAtMs ?? (rowStepToTimelineStep(step) as { startedAtMs?: number }).startedAtMs)
    : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running, startedAt]);
  const liveText = running && startedAt && now - startedAt >= 1000
    ? (() => { const s = Math.floor((now - startedAt) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; })()
    : "";
  return (
    <button
      type="button"
      className={`nx-trow is-${status}${hasDetails ? " is-openable" : ""}`}
      onClick={onToggle}
      aria-expanded={hasDetails ? expanded : undefined}
      disabled={!hasDetails}
    >
      <span className={`nx-trow__ic ${appIcon ? "" : className}`} aria-hidden="true">
        {running
          ? <DotSpinner size={12} />
          : appIcon
            ? <img className="atl-appicon" src={appIcon} alt="" />
            : failed
              ? <IconAlertCircle size={15} />
              : mcp
                ? <McpServerMark name={mcp.server} hint={mcp.server} />
              : step && rowStepDelegationModel(step) !== null
                /* 子 Agent 行: 模型品牌 logo, 不是一个小人 (10-21) */
                ? <AgentBrandLogo model={rowStepDelegationModel(step) || undefined} size={15} className="nx-trow__brand" fallback={<ToolGlyph name="agent" />} />
                : <ToolGlyph name={toolGlyphName(shownVerb, step ? rowStepIconKind(step) : undefined)} />}
      </span>
      <LiveShimmerText className="nx-trow__v" title={shownVerb} text={shownVerb} live={running} />
      {obj && <span className="nx-trow__o" title={obj}>{obj}</span>}
      {ds && ds !== "void" && (
        <span className="nx-trow__m nx-trow__diff">
          {ds.add > 0 && <i className="is-add">+{ds.add}</i>}
          {ds.del > 0 && <i className="is-del">−{ds.del}</i>}
        </span>
      )}
      {ds === "void" && <span className="nx-trow__m is-bad">{isZh ? "未写入" : "not written"}</span>}
      {rest.length > 0 && <span className="nx-trow__m" title={rest.join(" · ")}>{rest.join(" · ")}</span>}
      <span className="nx-trow__d">{running ? liveText : durText}</span>
      <span className={`nx-trow__c${expanded ? " is-open" : ""}`} aria-hidden="true">
        {hasDetails ? <IconChevronRight size={12} /> : null}
      </span>
    </button>
  );
};

export const ActivityChildRow: React.FC<{ row: Row; index: number; soleThinkingChild?: boolean; soleRedundantChild?: boolean; flat?: boolean; thinkMore?: RowStep[] }> = React.memo(({ row, index, soleThinkingChild, soleRedundantChild, flat, thinkMore }) => {
  const { isZh } = useI18n();
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const step = firstStepOfRow(row);
  const status = step ? rowStepStatus(step) : "done";
  const iconKind = step ? rowStepIconKind(step) : "task";
  const { Icon, className } = getStepIconInfo(iconKind);
  const appIcon = step ? rowStepAppIcon(step) : undefined;
  const hasDetails = row.kind !== "message" && !rowBodyWouldBeEmpty(row);
  const contentHint = step ? rowStepContentTypeHint(step)?.replace(/_/g, "-") : undefined;
  const waitingAsk = rowHasWaitingAsk(row);
  const awaitingApproval = status === "awaiting";
  const runningLive = status === "running" || status === "pending";
  /* 终端审批中不展开空壳; 点允许后 running 立刻展开行头 (contentOnly 无输出时仍 return null, 不挂白 xterm). */
  const isTerminalish =
    contentHint === "terminal" || contentHint === "exec";
  const expandLive =
    waitingAsk ||
    (!awaitingApproval &&
      (isTerminalish
        ? status === "failed" || runningLive
        : runningLive));
  const expanded = hasDetails && (
    /* 定版: 读取 / 搜索跑着时不自己摊开那张 Explore 进度卡 —— 行尾在计时就够了, 摊开再收回去是整屏跳 */
    (flat && userToggled === null && (contentHint === "explore" || contentHint === "explore-group" || contentHint === "background-task" || contentHint === "delegation") ? false : expandLive)
    /* 只有一次思考时子行**没有自己的头** (见 activityChildHead.ts), 也就没有任何地方
     * 能把它点开 —— 折叠开关在外层活动头上。所以这里必须强制展开: 父活动一展开,
     * 思考正文就该直接出来。漏了这一条会变成"点开外层什么都不显示"。 */
    || soleThinkingChild
    /* 跟外层说同一件事的唯一子行: 头藏了 (见 activityChildHead.ts), 内容 (diff / 改了什么)
     * 直接挂在外层头下面 —— 折叠入口是外层那一行, 外层一展开就该看到内容。 */
    || soleRedundantChild
    /* Code 定版: 改动 diff、待办、提问默认就摊开 —— 这些是这一步的全部意义, 收起来还要点一下 */
    || (flat && userToggled === null && (
      (!!contentHint && FLAT_OPEN_BY_DEFAULT.has(contentHint))
      || (() => { const ds = activityChildDiffStat(row); return !!ds && ds !== "void"; })()
    ))
    || (userToggled ?? (contentHint === "neox-card" || contentHint === "timer-card" || contentHint === "change" || contentHint === "seen-images"))
  );
  const contentOwnsChrome =
    contentHint === "explore" || contentHint === "explore-group";
  const showChildHead = shouldShowActivityChildHead({
    expanded, contentOwnsChrome, expandLive, userToggled, kind: row.kind, soleThinkingChild, soleRedundantChild,
  });
  const title = activityChildTitle(row);
  const meta = activityChildMeta(row);
  const metaText = meta.join(" · ");
  useEffect(() => {
    if (expandLive) setUserToggled(null);
  }, [expandLive]);
  const toggle = useCallback(() => {
    if (!hasDetails) return;
    setUserToggled((current) => !(expandLive || (current ?? false)));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("neox:timeline-layout-transition", {
        detail: { source: "activity-child", durationMs: 320 }
      }));
    }
  }, [hasDetails, expandLive]);

  /* 待办: 工具回的是一段带 ✓ ◐ ○ 的文字, 拆得出两条以上就画成清单卡 */
  const todoLines = flat && row.kind === "single" && /^(待办|Todo|更新 TODO)/i.test(title) ? (() => {
    const lines = rowStepCodeLines(row.step);
    return lines && parseTodoLines(lines).length >= 2 ? lines : undefined;
  })() : undefined;

  /* 找工具: 回的是「Found 4 tool(s): / name: 一大段英文说明」—— 只列找到的工具名 */
  const foundTools = flat && row.kind === "single" && !todoLines ? (() => {
    const lines = rowStepCodeLines(row.step);
    if (!lines || !/^Found \d+ tool/i.test(lines[0]?.trim() ?? "")) return undefined;
    /* 工具名顶格写, 参数缩进写 (Parameters: 下面那几行) —— 只认顶格且带下划线 / 全小写的那种 */
    const names = lines
      .filter((l) => !/^\s/.test(l))
      .map((l) => /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+):\s/.exec(l)?.[1])
      .filter((n): n is string => !!n);
    return names.length ? names : undefined;
  })() : undefined;

  /* 连着的几截思考合成的全文 (见 mergeThinkingRuns) */
  const mergedThought = flat && thinkMore && thinkMore.length && row.kind === "single"
    ? [row.step, ...thinkMore].map(thinkingTextOf).join("")
    : undefined;
  if (flat && isThinkingRow(row) && row.kind === "single" && status !== "running" && status !== "pending"
    && (mergedThought ?? thinkingTextOf(row.step)).replace(/[\s.。,，…·\-_*`'"]+/g, "").length < 16) {
    return null;
  }

  /* 出图还在跑: 工具只回了入参 JSON —— 画成一张出图占位卡 (按尺寸比例的扫光框 + 提示词), 不摊 JSON */
  const imageJob = flat && row.kind === "single" && /生成图片|出图|改图|generate.?image|edit.?image/i.test(title) ? (() => {
    const lines = rowStepCodeLines(row.step);
    if (!lines) return undefined;
    try {
      const j = JSON.parse(lines.join("\n")) as { prompt?: string; size?: string };
      if (typeof j.prompt !== "string") return undefined;
      const m = /^(\d+)x(\d+)$/.exec(j.size ?? "");
      return { prompt: j.prompt, ratio: m ? Number(m[1]) / Number(m[2]) : 1, size: j.size };
    } catch { return undefined; }
  })() : undefined;

  if (flat) {
    /* 定版: 头永远在 (它就是这一行), 内容卡在下面占满列宽; 思考正文对齐动词列 (CSS 管) */
    return (
      <div
        className={`nx-tool is-${status}${expanded ? " is-expanded" : ""}${contentHint ? ` is-content-${contentHint}` : ""}${isThinkingRow(row) ? " is-think" : ""}`}
        data-timeline-step-ids={rowStepIds(row).join(" ")}
        data-content-type={contentHint}
      >
        <FlatRowHead
          row={row}
          title={title}
          meta={todoLines ? (() => {
            const items = parseTodoLines(todoLines);
            return [`${items.filter((i) => i.state === "done").length} / ${items.length}`, ...meta.filter((m) => !/项|items?$/.test(m))];
          })() : foundTools ? [isZh ? `找到 ${foundTools.length} 个` : `${foundTools.length} found`, ...meta] : meta}
          /* 询问: 问题原文放卡里, 行头只留「询问」不再抄一遍 */
          hideObject={!!todoLines || contentHint === "ask-user" || contentHint === "askUser"}
          status={status}
          hasDetails={hasDetails}
          expanded={expanded}
          onToggle={toggle}
        />
        <SmoothCollapse open={expanded}>
          <div className="nx-tool__body">
            {imageJob ? (
              <div className="nx-imgjob">
                <div className={`nx-imgjob__frame${status === "running" || status === "pending" ? " is-live" : ""}`} style={{ aspectRatio: String(imageJob.ratio) }}>
                  <ToolGlyph name="image" size={22} />
                </div>
                <div className="nx-imgjob__m">
                  <div className="nx-imgjob__p">{imageJob.prompt}</div>
                  <div className="nx-imgjob__s">
                    {status === "running" || status === "pending" ? (isZh ? "正在出图" : "Generating") : (isZh ? "出图请求" : "Image request")}
                    {imageJob.size ? ` · ${imageJob.size.replace("x", " × ")}` : ""}
                  </div>
                </div>
              </div>
            ) : mergedThought !== undefined ? (
              <div className="atl-thinking nx-think-merged">{mergedThought.trim()}</div>
            ) : todoLines ? (
              <div className="nx-tcard is-flat"><TodoChecklist lines={todoLines} /></div>
            ) : foundTools ? (
              <div className="nx-tcard is-flat nx-chips">
                {foundTools.map((n) => <code key={n} className="nx-chip">{n}</code>)}
              </div>
            ) : row.kind === "cluster" ? (
              /* 同类合并的「找工具 ×3」: 展开后每一条就是一行工具 (同一套行 + 卡), 不再把三份原始输出叠成一大段 */
              <div className="nx-tool__list" role="list" aria-label={title}>
                {row.items.map((item, i) => (
                  <div key={rowStepId(item)} role="listitem">
                    <ActivityChildRow row={{ kind: "single", step: item }} index={i} flat />
                  </div>
                ))}
              </div>
            ) : (
              <RowContent row={row} activityChild contentOnly />
            )}
          </div>
        </SmoothCollapse>
      </div>
    );
  }

  return (
    <div
      className={`atl-activity-child is-${status}${expanded ? " is-expanded" : ""}${
        contentHint ? ` is-content-${contentHint}` : ""
      }${!showChildHead ? " is-headless" : ""}`}
      data-activity-child-index={index}
      data-timeline-step-ids={rowStepIds(row).join(" ")}
      data-content-type={contentHint}
    >
      {showChildHead && (
      <button
        type="button"
        className="atl-activity-child__head"
        onClick={toggle}
        aria-expanded={hasDetails ? expanded : undefined}
        disabled={!hasDetails}
      >
        {/* 有真实 App 图标就用它 (Computer Use): 用户要的是"动的是哪个软件", 一眼认出,
            不用读字。没有就退回我们自己画的线性 glyph。两者占同一个 14px 盒子, 不破对齐。 */}
        <span
          className={`atl-activity-child__icon ${appIcon ? "atl-activity-child__icon--app" : className}`}
          aria-hidden="true"
        >
          {status === "running"
            ? <DotSpinner size={12} />
            : appIcon
              ? <img className="atl-appicon" src={appIcon} alt="" />
              : <Icon size={14} />}
        </span>
        <span className="atl-activity-child__main">
          <LiveShimmerText className="atl-activity-child__title" title={title} text={title} live={status === "running"} />
          {(() => {
            const ds = activityChildDiffStat(row);
            if (!ds) return null;
            if (ds === 'void') {
              return (
                <span className="atl-activity__diff is-void" title={isZh ? '这次编辑失败了，文件未被修改' : 'This edit failed; the file was not modified'}>
                  {isZh ? '未写入' : 'not written'}
                </span>
              );
            }
            return (
              <span className="atl-activity__diff">
                <span className="atl-activity__diff-add">+{ds.add}</span>
                <span className="atl-activity__diff-del">-{ds.del}</span>
              </span>
            );
          })()}
          {metaText && <span className="atl-activity-child__meta" title={metaText}>{metaText}</span>}
        </span>
        <span className="atl-activity-child__status" aria-hidden="true" />
      </button>
      )}
      {expanded && (
        <div
          className={`atl-activity-child__details${row.kind === "cluster" ? " atl-activity-child__details--cluster" : ""}`}
          /* 替代 `.atl-activity-child__details:has(...is-content-diff/turn-summary)` */
          data-atl-wide-content={rowHasWideContent(row) ? "1" : undefined}
        >
          {row.kind === "cluster" ? (
            <div className="atl-activity-child__cluster-list" role="list" aria-label={title}>
              {row.items.map((item) => (
                <div key={rowStepId(item)} className="atl-activity-child__cluster-item" role="listitem">
                  {/* contentOnly: 子行头已由 ActivityChildRow 画过, 避免 cluster 再叠一层 TimelineStep 头/chevron */}
                  <TimelineStep step={rowStepToTimelineStep(item)} activityChild contentOnly />
                </div>
              ))}
            </div>
          ) : (
            <RowContent row={row} activityChild contentOnly />
          )}
        </div>
      )}
    </div>
  );
});
ActivityChildRow.displayName = "ActivityChildRow";

const ActivityRowImpl: React.FC<{
  activity: Extract<Row, { kind: "activity" }>;
  turnActive?: boolean;
  digest?: boolean;
}> = ({ activity, turnActive, digest = false }) => {
  const { isZh } = useI18n();
  const modeVariant = useAgentModeVariant();
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const hasLiveChild = useMemo(
    () => activity.hasActive || activity.rows.some(rowHasLiveStep),
    [activity.hasActive, activity.rows]
  );
  const hasRunningChild = useMemo(
    () => activity.hasActive || activity.rows.some(rowHasRunningStep),
    [activity.hasActive, activity.rows]
  );
  /* 阻塞 ask_user 必须可见可点 — plain/minimal 默认折叠 Actions 会把 AskUserView 卸出 DOM,
   * 用户只能看到底部 dock, 点不了选项; 打断后 re-render 才"突然出现". 有 waiting ask 时
   * 强制 keepOpen, 并在 expanded 计算里压过 plain 默认折叠. */
  const hasWaitingAsk = useMemo(
    () => activity.rows.some(rowHasWaitingAsk),
    [activity.rows]
  );
  /* 审批挡住整轮时不要挂 is-running shimmer — transparent + clip 在 IDE 里会把摘要头扫成空白. */
  const isAwaitingApproval = useMemo(
    () =>
      activity.rows.some((r) => {
        const s = firstStepOfRow(r);
        return s ? rowStepStatus(s) === "awaiting" : false;
      }),
    [activity.rows]
  );
  const running = hasLiveChild;
  const keepOpen = running || !!turnActive || hasWaitingAsk;
  const showShimmer = !isAwaitingApproval && (hasRunningChild || !!turnActive);
  const childCount = activity.opCount;
  const layoutDispatchTimerRef = useRef<number | null>(null);
  const prevChildCount = useRef(childCount);
  const seenChildContentRef = useRef<Set<string> | null>(null);
  const clearFreshChildTimerRef = useRef<number | null>(null);
  const [, forceFreshChildSweep] = useState(0);
  const isActivityChildFresh = useCallback((row: Row, index: number) => {
    const seen = seenChildContentRef.current;
    const ids = contentIdsOf(row);
    return (
      seen != null &&
      ids.length > 0 &&
      ids.every((id) => !seen.has(id))
    );
  }, []);
  useEffect(() => {
    if (activity.rows.length === 0) return;
    const canMarkFresh = !!seenChildContentRef.current;
    if (!seenChildContentRef.current) seenChildContentRef.current = new Set();
    const seen = seenChildContentRef.current;
    let hadFreshChild = false;
    const freshChildren: Array<Record<string, unknown>> = [];
    for (let i = 0; i < activity.rows.length; i++) {
      const row = activity.rows[i];
      if (!row) continue;
      const ids = contentIdsOf(row);
      if (canMarkFresh && ids.length > 0 && ids.every((id) => !seen.has(id))) {
        hadFreshChild = true;
        if (isTimelineDebugEnabled() && freshChildren.length < 12) {
          freshChildren.push({
            index: i,
            key: `${rowKeyOf(row, i)}#${i}`,
            kind: debugRowKind(row),
            label: getDebugRowLabel(row),
          });
        }
      }
      for (const id of ids) seen.add(id);
    }
    if (hadFreshChild && typeof window !== "undefined") {
      logTimelineJank("activity-child-fresh-marked", {
        activityId: activity.id,
        childCount: activity.rows.length,
        examples: freshChildren,
        clearMs: ACTIVITY_CHILD_FRESH_CLASS_CLEAR_MS,
      });
      if (clearFreshChildTimerRef.current !== null) {
        window.clearTimeout(clearFreshChildTimerRef.current);
      }
      clearFreshChildTimerRef.current = window.setTimeout(() => {
        clearFreshChildTimerRef.current = null;
        logTimelineJank("activity-child-fresh-cleared", {
          activityId: activity.id,
          childCount: activity.rows.length,
          clearMs: ACTIVITY_CHILD_FRESH_CLASS_CLEAR_MS,
        });
        forceFreshChildSweep((value) => value + 1);
      }, ACTIVITY_CHILD_FRESH_CLASS_CLEAR_MS);
    }
  }, [activity.id, activity.rows]);
  useEffect(() => () => {
    if (clearFreshChildTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(clearFreshChildTimerRef.current);
      clearFreshChildTimerRef.current = null;
    }
  }, []);
  const scheduleLayoutTransition = useCallback(
    (delay = 80, anchorEl?: HTMLElement | null, reason = "activity") => {
      if (typeof window === "undefined") return;
      if (layoutDispatchTimerRef.current !== null) {
        window.clearTimeout(layoutDispatchTimerRef.current);
      }
      layoutDispatchTimerRef.current = window.setTimeout(() => {
        layoutDispatchTimerRef.current = null;
        logTimelineJank("activity-layout-transition", {
          activityId: activity.id,
          reason,
          opCount: activity.opCount,
          running,
          keepOpen,
          delay,
          anchorKey: anchorEl?.dataset.timelineRowKey,
        });
        // 只广播“高度动画期”信号给父 timeline 冻结测高；不再做任何 scrollTop 锚点修正。
        // 这样 Actions/Plan/工具展开动画仍然保留，但虚拟高度不会采到动画中间态。
        window.dispatchEvent(new CustomEvent("neox:timeline-layout-transition", {
          detail: { source: "activity", durationMs: LAYOUT_ANCHOR_TRANSITION_MS, anchorKey: anchorEl?.dataset.timelineRowKey }
        }));
      }, delay);
    },
    [activity.id, activity.opCount, keepOpen, running]
  );
  useEffect(
    () => () => {
      if (layoutDispatchTimerRef.current !== null) {
        window.clearTimeout(layoutDispatchTimerRef.current);
      }
    },
    []
  );
  useEffect(() => {
    if (childCount !== prevChildCount.current) {
      prevChildCount.current = childCount;
      /* 流式工具一条条到达时不要每条都开 460ms anchor RAF。合并到一小段
       * layout transition，避免 Actions timeline 整体闪烁/粘手。 */
      if (keepOpen) scheduleLayoutTransition(120, undefined, "child-count-change");
    }
  }, [childCount, keepOpen, scheduleLayoutTransition]);
  const plain = modeVariant.isWork;
  const [nowTick, setNowTick] = useState(() => Date.now());
  const showLiveElapsed = showShimmer || isAwaitingApproval;
  useEffect(() => {
    if (!showLiveElapsed || typeof window === "undefined") return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [showLiveElapsed]);
  const runningElapsed = useMemo(() => {
    if (!showLiveElapsed) return undefined;
    const startedAt = currentRunningStartedAtMs(activity);
    if (!startedAt || startedAt <= 0) return undefined;
    const ms = nowTick - startedAt;
    if (ms < 1000) return undefined;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }, [activity, nowTick, showLiveElapsed]);
  /* 审批中也要标题 (等待确认 · …); 不能绑 showShimmer, 否则关掉光带后摘要头空白. */
  const briefBase =
    showShimmer || isAwaitingApproval ? currentRunningTitle(activity, { plain }) : undefined;
  const brief = briefBase && runningElapsed ? `${briefBase} · ${runningElapsed}` : briefBase;
  const rollKey = useMemo(
    () => (showShimmer ? currentRunningKey(activity, { plain }) : undefined),
    [activity, plain, showShimmer],
  );
  const summary = digest
    ? (!showShimmer ? activityDigestSummary(activity, { withDiff: false }) : undefined)
    : ((!keepOpen || plain) ? activitySummary(activity) : undefined);
  const digestSegments = digest && !showShimmer
    ? activityDigestSegments(activity, { withDiff: false, plain })
    : null;
  const elapsed = (digest ? !showShimmer : !keepOpen) ? activityDuration(activity) : undefined;
  /* 默认展开策略:
   *   Work 模式: 保持老行为 —— running 时默认展开显示每一步 tool
   *   Life 模式: 默认折叠只显 shimmer 简报 (Neox 正在读取 X · Read×3 · Edit×2),
   *             整轮 tool 群不刷屏, 用户点头部想看细节才展.
   * 历史 reload 都按上面初始; 用户点击 (userToggled) 永远优先.
   * 例外: waiting ask 是阻塞交互, 必须展开挂载 AskUserView, 否则 Life 折叠会把卡卸出 DOM. */
  /* digest 变体跟 Life 同款默认折叠 — 折叠态本身就是信息载体 (摘要行), running 也不自动铺开. */
  const collapsedByDefault = plain || digest;
  /* 这一段活动是不是"只有一次思考" —— 是的话子行不画自己的头 (见 activityChildHead.ts)。
   * 跟模式无关: 任何模式下模型想一下就直接答, 都会命中这一支。 */
  const soleThinkingChild = activity.rows.length === 1 && isThinkingRow(activity.rows[0]);
  const activityBrandIcon = useMemo(() => {
    const icons = activity.rows.filter((r) => !isThinkingRow(r)).flatMap((r) =>
      r.kind === "single" ? [rowStepAppIcon(r.step)]
        : r.kind === "cluster" || r.kind === "group" ? r.items.map(rowStepAppIcon)
          : [undefined]);
    return icons.length > 0 && icons.every((i) => i && i === icons[0]) ? icons[0] : undefined;
  }, [activity.rows]);
  /* 唯一子行且跟外层说同一件事 → 那一行是纯重复 (见 activityChildHead 注释)。
   * 判据取两边标题里的**文件名**: 外层「编辑 new.ts」/ 子行「写入文件 · src/new.ts」
   * 取 basename 一比就知道是不是同一个文件, 比比对整串稳 (一个带路径一个不带)。 */
  const soleRedundantChild = (() => {
    const shown = plain
      ? activity.rows.filter((row) => rowHasRunningStep(row) || rowHasWaitingAsk(row) || !isPlainHiddenRow(row))
      : activity.rows;
    if (shown.length !== 1) return false;
    /* 外层头实际显示的那串: digest 走分段 (Work 的 plain 标题), 否则 activitySummary */
    const squash = (t: string) => t.replace(/\s+/g, '');
    const parentTitle = digest
      ? activityDigestSegments(activity, { withDiff: false, plain })
        .map((p) => `${p.head ?? ''}${p.rest ?? ''}`).join('·')
      : (activitySummary(activity) || '');
    const childTitle = activityChildTitle(shown[0]) || '';
    if (squash(parentTitle) && squash(parentTitle) === squash(childTitle)) return true;
    const base = (t: string) => {
      const m = /([\w.-]+\.[A-Za-z0-9]+)/.exec(t || '');
      return m ? m[1].split('/').pop()! : '';
    };
    const parent = base(parentTitle);
    return !!parent && parent === base(childTitle);
  })();
  const [autoExpanded, setAutoExpanded] = useState(collapsedByDefault && !hasWaitingAsk ? false : keepOpen);
  useEffect(() => {
    if (userToggled !== null) return;
    /* Life/digest 默认折叠, 但 waiting ask 是阻塞交互, 必须自动展开让选项卡可点. */
    if (collapsedByDefault && !hasWaitingAsk) return;
    if (keepOpen || hasWaitingAsk) {
      setAutoExpanded(true);
    }
  }, [keepOpen, userToggled, collapsedByDefault, hasWaitingAsk]);
  const expanded = hasWaitingAsk
    ? true
    : userToggled !== null
      ? userToggled
      : (running && !collapsedByDefault ? true : autoExpanded);
  const [renderActivityChildren, setRenderActivityChildren] = useState(expanded);
  const [progressiveChildLimit, setProgressiveChildLimit] = useState(
    ACTIVITY_REVEAL_INITIAL_COUNT
  );
  useEffect(() => {
    if (expanded) {
      setRenderActivityChildren(true);
      setProgressiveChildLimit(ACTIVITY_REVEAL_INITIAL_COUNT);
      return;
    }
    setProgressiveChildLimit(ACTIVITY_REVEAL_INITIAL_COUNT);
    if (!renderActivityChildren) return;
    if (typeof window === "undefined") {
      setRenderActivityChildren(false);
      return;
    }
    const timer = window.setTimeout(() => {
      logTimelineJank("activity-children-unmount", {
        activityId: activity.id,
        childCount: activity.rows.length,
      });
      setRenderActivityChildren(false);
    }, 460);
    return () => window.clearTimeout(timer);
  }, [activity.id, activity.rows.length, expanded, renderActivityChildren]);
  const targetChildren = useMemo(() => {
    const all = activity.rows.map((row, index) => ({ row, index }));
    if (!plain) return all;
    return all.filter(({ row }) => rowHasRunningStep(row) || rowHasWaitingAsk(row) || !isPlainHiddenRow(row));
  }, [activity.rows, plain]);
  const hiddenChildCount = activity.rows.length - targetChildren.length;
  const seenImages = useMemo(() => rowsSeenImages(activity.rows), [activity.rows]);

  useEffect(() => {
    if (!expanded || !renderActivityChildren) return;
    const target = targetChildren.length;
    if (progressiveChildLimit >= target) return;
    const timer = window.setTimeout(() => {
      setProgressiveChildLimit((n) =>
        Math.min(target, n + ACTIVITY_REVEAL_CHUNK_SIZE)
      );
    }, ACTIVITY_REVEAL_CHUNK_MS);
    return () => window.clearTimeout(timer);
  }, [expanded, renderActivityChildren, progressiveChildLimit, targetChildren.length]);

  useLayoutEffect(() => {
    if (!expanded || !renderActivityChildren) return;
    if (typeof document === "undefined") return;
    if (!isTimelineBottomFollowIntentActive()) return;
    if (isTimelineUserScrollGuardActive()) return;
    const feed = document.querySelector<HTMLElement>(".atl-feed");
    if (!feed) return;
    const maxScroll = Math.max(0, feed.scrollHeight - feed.clientHeight);
    if (maxScroll - feed.scrollTop > 1) feed.scrollTop = maxScroll;
  }, [progressiveChildLimit, renderActivityChildren, expanded]);

  const visibleChildren = useMemo(() => {
    if (!expanded) return targetChildren;
    const limit = Math.min(progressiveChildLimit, targetChildren.length);
    return targetChildren.filter((child, position) => {
      /* 审批中 / 正在跑的工具必须首帧就挂上 — 不能等 progressive reveal 过一会才出现空头 */
      return (
        position < limit ||
        rowHasWaitingAsk(child.row) ||
        rowHasRunningStep(child.row)
      );
    });
  }, [expanded, progressiveChildLimit, targetChildren]);
  const revealingChildren =
    expanded && renderActivityChildren && visibleChildren.length < targetChildren.length;
  useEffect(() => {
    if (!isTimelineDebugEnabled()) return;
    logTimelineJank("activity-render-children", {
      activityId: activity.id,
      expanded,
      renderActivityChildren,
      rowCount: activity.rows.length,
      targetCount: targetChildren.length,
      visibleCount: visibleChildren.length,
      progressiveChildLimit,
      revealing: revealingChildren,
    });
  }, [
    activity.id,
    activity.rows.length,
    expanded,
    progressiveChildLimit,
    renderActivityChildren,
    revealingChildren,
    targetChildren.length,
    visibleChildren.length,
  ]);

  const toggle = (event: React.MouseEvent<HTMLElement>) => {
    const anchorEl = event.currentTarget.closest<HTMLElement>(
      ".atl-row-clamp[data-timeline-row-index]"
    );
    logTimelineJank("activity-user-toggle", {
      activityId: activity.id,
      fromExpanded: expanded,
      nextExpanded: !expanded,
      opCount: activity.opCount,
    });
    setUserToggled(!expanded);
    scheduleLayoutTransition(16, anchorEl, "user-toggle");
  };

  const label = plain
    ? (isZh ? '工作任务' : 'Working Actions')
    : digest
      ? (isZh ? '过程' : 'Worked')
      : (isZh ? '操作' : 'Actions');

  return (
    <div
      className={`atl-activity${expanded ? " is-expanded" : ""}${
        showShimmer ? " is-running" : ""
      }${isAwaitingApproval ? " is-awaiting" : ""}${plain ? " is-plain" : ""}${digest ? " is-digest" : ""}${
        /* 「整段活动只有一次思考」单独挂一个类 —— 这一支的视觉要求跟别的活动**相反**:
         * 别的活动是"一组操作", 需要图标和卡片把它们framed 起来; 这一支只是模型想了一下,
         * 它更接近正文的前言, 应该贴着正文那一列平铺。样式全在 agent-timeline.css 末尾。
         * 跟模式无关: code/life/work 三个模式都会命中。 */
        soleThinkingChild ? " is-sole-thinking" : ""
      }`}
    >
      <button
        type="button"
        className="atl-activity__head"
        onClick={toggle}
        aria-expanded={expanded}
      >
        {!plain && (
          <span className="atl-activity__icon" aria-hidden="true">
            {activityBrandIcon
              ? <img className="atl-appicon" src={activityBrandIcon} alt="" />
              : <IconLayers size={14} />}
          </span>
        )}
        <span className="atl-activity__main">
          {(() => {
            /* 标题永远走固态 summary/brief 节点 — 不用依赖 clip shimmer 才能看见字.
             * 审批中 / 刚点允许后的 running 空窗都必须立刻有可读文案. */
            const lastStep = briefBase ? undefined : lastSettledTitle(activity);
            const liveTitle = briefBase
              || (lastStep
                ? `${isZh ? '正在思考' : 'Thinking'} · ${isZh ? '上一步' : 'after'}: ${lastStep}`
                : (isZh ? '正在思考…' : 'Thinking…'));
            const doneSummary = activitySummary(activity);
            const runningText = liveTitle;
            const headText = (showShimmer || isAwaitingApproval)
              ? runningText
              : (summary || doneSummary || label);
            const useBriefClass = showShimmer && !isAwaitingApproval;
            if (useBriefClass) {
              return (
                <>
                  <ActivityBrief text={headText} live={showShimmer} rollKey={rollKey} />
                  {digest && <ActivityDiffBadge activity={activity} live />}
                </>
              );
            }
            return (
              <>
                {!digest && !isAwaitingApproval && !showShimmer && (
                  <span className="atl-activity__label">{label}</span>
                )}
                <span className="atl-activity__summary">
                  {digestSegments
                    ? digestSegments.map((p, i) => (
                        <React.Fragment key={i}>
                          {i > 0 && digestSeparator(isZh)}
                          {p.head && <span className="atl-activity__verb">{p.head}</span>}
                          {p.rest}
                        </React.Fragment>
                      ))
                    : headText}
                </span>
                {!showShimmer && (() => {
                  const f = activityFailureCount(activity);
                  if (!f) return null;
                  return (
                    <span className="atl-activity__fail" title={isZh ? '这段里有步骤失败' : 'Some steps failed'}>
                      {isZh ? `${f} 处失败` : `${f} failed`}
                    </span>
                  );
                })()}
                {digest && <ActivityDiffBadge activity={activity} live={showShimmer || running} />}
              </>
            );
          })()}
        </span>
        {/* Life 用户不需要看工具耗时; 且 "0ms" 语义化零, 属于展示噪音 */}
        {showLiveElapsed
          ? (runningElapsed && !plain ? (
              <span className="atl-activity__elapsed">{runningElapsed}</span>
            ) : (
              <span className="atl-activity__elapsed atl-activity__elapsed--slot" aria-hidden="true" />
            ))
          : (elapsed && !plain && !/^0m?s$/i.test(elapsed) ? (
              <span className="atl-activity__elapsed">{elapsed}</span>
            ) : (
              <span className="atl-activity__elapsed atl-activity__elapsed--slot" aria-hidden="true" />
            ))}
        {/* 组头的折叠箭头一并去掉 —— 跟子行同一个理由 (整行可点, 箭头只是重复宣告)。
            留空 span 占住这一槽, 否则 elapsed 会往右跳。 */}
        <span className="atl-activity__chevron" aria-hidden="true" />
      </button>
      {/* 折着也看得见它看过的图 (同 TurnFoldRow) —— 展开后图回到那一步里, 这排就收掉 */}
      {!expanded && seenImages.length > 0 && (
        <div className="atl-activity__seen">
          <SeenImagesView images={seenImages.slice(0, 6)} compact />
        </div>
      )}
      {(expanded || renderActivityChildren) && (
        <div className={`atl-activity__body-shell${expanded ? " is-open" : ""}`}>
          <div className="atl-activity__body-shell-inner">
            {renderActivityChildren && visibleChildren.map(({ row, index }) => (
              <React.Fragment key={rowKeyOf(row, index)}>
                <div
                  className={`atl-row-clamp atl-row-clamp--activity-child${
                    isActivityChildFresh(row, index)
                      ? " atl-row-clamp--activity-child-fresh"
                      : ""
                  }`}
                >
                  <ActivityChildRow row={row} index={index} soleThinkingChild={soleThinkingChild} soleRedundantChild={soleRedundantChild} />
                </div>
              </React.Fragment>
            ))}
            {renderActivityChildren && !revealingChildren && hiddenChildCount > 0 && targetChildren.length === 0 && (
              <div className="nx-work-hidden-steps">
                {isZh ? `${hiddenChildCount} 个幕后步骤 (思考、处理数据等)` : `${hiddenChildCount} behind-the-scenes steps`}
              </div>
            )}
            {revealingChildren && (
              <div className="atl-activity__revealing" aria-hidden="true">
                <span />
                <span />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
ActivityRowImpl.displayName = "ActivityRow";

export const ActivityRow = React.memo(ActivityRowImpl);

/* 跑着的组头播报: 有工具在跑写工具, 两个工具之间写当前阶段 (思考中 / 整理结果 / 规划中 / 重试中 …)。
 * 同一个滚动组件, 工具 ↔ 阶段之间也是一句顶一句。只有活的那一组挂它 (它订阅了时间轴 feed)。 */
/** Code: 这一组的头是不是在滚动播报 (活的那一组且合成了组头) —— 是的话时间线底部不再另挂阶段行 */
export function flatGroupHeadRolls(a: Extract<Row, { kind: "activity" }>): boolean {
  if (a.rows.filter((r) => !isThinkingRow(r)).length < 2) return false;
  return a.inActiveTurn === true || a.rows.some(rowHasRunningStep) || a.rows.some(rowHasWaitingAsk);
}

const LiveGroupBrief: React.FC<{ isZh: boolean; toolText: string | null; toolKey: string }> = ({ isZh, toolText, toolKey }) => {
  const { phase, label } = useWaitingPhase(isZh);
  return toolText !== null
    ? <ActivityBrief text={toolText} live rollKey={toolKey} />
    : <ActivityBrief text={label} live rollKey={`phase:${phase}`} />;
};

export const FlatActivityRow: React.FC<{ activity: Extract<Row, { kind: "activity" }> }> = React.memo(({ activity }) => {
  const { isZh } = useI18n();
  /* 这一轮还在这一段上干活 (inActiveTurn 只标在当前轮最后一段) 也算跑着 —— 两个工具之间模型在想, 头上照样滚
   * 「思考中」, 不在摘要和播报之间来回跳 */
  const running = activity.rows.some(rowHasRunningStep) || activity.rows.some(rowHasWaitingAsk) || activity.inActiveTurn === true;
  /* 两段话之间连着好几个工具 (真实会话的常态: 五六个工具 → 一段话 → 又一串工具):
   * 合成一行「读取 2 个文件 · 运行 3 条命令 · 编辑 math.js   6 步  4.2s ›」, 点开才逐行列。
   * 思考不算工具; 只有一个工具时不合, 那一行本身就是它。跑着的那组摊开 (看得见进度), 跑完收起。 */
  const tools = activity.rows.filter((r) => !isThinkingRow(r));
  /* 跑着的那一段从第一个工具起就进播报行 (不先冒一条单行再缩) */
  const grouped = tools.length >= 2;
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  /* 跑着的组默认收着, 头上一行滚动播报当前工具 (下一个工具从下面顶上来, 当前那句扫光) —— 不再一条条往下铺 */
  const open = !grouped || (userOpen ?? false);
  /* null = 两个工具之间没有在跑的: 播报行写当前阶段 (思考中 / 整理结果 / 规划中 …), 由 LiveGroupBrief 读 */
  const liveTitle = running ? (currentRunningTitle(activity) ?? null) : null;
  const liveKey = running ? currentRunningKey(activity) : "";
  const liveStart = running ? currentRunningStartedAtMs(activity) : undefined;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running || !grouped) return; /* 只有播报行要跳秒; 单行自己计时 */
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [running, grouped]);
  const liveElapsed = liveStart && Date.now() - liveStart >= 1000
    ? (() => { const s = Math.floor((Date.now() - liveStart) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; })()
    : "";
  const merged = useMemo(() => mergeThinkingRuns(activity.rows), [activity.rows]);
  const rows = (
    <>
      {merged.rows.map((row, index) => (
        <ActivityChildRow key={rowKeyOf(row, index)} row={row} index={index} flat thinkMore={merged.more.get(row)} />
      ))}
    </>
  );
  if (!grouped) return <div className={`nx-tlist${running ? " is-running" : ""}`}>{rows}</div>;
  const segs = activityDigestSegments(activity, { withDiff: false });
  const diff = activityDigestDiffTotal(activity);
  const fails = activityFailureCount(activity);
  const dur = activityDuration(activity);
  const toggle = () => {
    setUserOpen(!open);
    window.dispatchEvent(new CustomEvent("neox:timeline-layout-transition", { detail: { source: "flat-group", durationMs: 320 } }));
  };
  return (
    <div className={`nx-tlist nx-tgroup${open ? " is-open" : ""}${running ? " is-running" : ""}`}>
      <button type="button" className="nx-trow nx-tgroup__head is-openable" onClick={toggle} aria-expanded={open}>
        <span className="nx-trow__ic" aria-hidden="true">
          {running ? <DotSpinner size={12} /> : fails > 0 ? <IconAlertCircle size={15} /> : <ToolGlyph name="group" />}
        </span>
        {running ? (
          <span className="nx-tgroup__live">
            <LiveGroupBrief
              isZh={isZh}
              toolText={liveTitle === null ? null : (() => {
                const t = flatTitle(liveTitle);
                const i = t.indexOf(" · ");
                return i > 0 ? `${flatVerb(t.slice(0, i))}  ${flatObject(t.slice(i + 3))}` : flatVerb(t);
              })()}
              toolKey={liveKey}
            />
          </span>
        ) : (
        <span className="nx-tgroup__sum">
          {segs.map((p, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="nx-tgroup__sep"> · </span>}
              {p.head && <span className="nx-tgroup__verb">{flatVerb(p.head.trim())}</span>}
              {p.rest && <span className="nx-tgroup__rest">{p.rest}</span>}
            </React.Fragment>
          ))}
        </span>
        )}
        {diff && (diff.add > 0 || diff.del > 0) && (
          <span className="nx-trow__m nx-trow__diff">
            {diff.add > 0 && <i className="is-add">+{diff.add}</i>}
            {diff.del > 0 && <i className="is-del">−{diff.del}</i>}
          </span>
        )}
        {fails > 0 && <span className="nx-trow__m is-bad">{isZh ? `${fails} 处失败` : `${fails} failed`}</span>}
        <span className="nx-trow__m nx-tgroup__n">{isZh ? `${tools.length} 步` : `${tools.length} steps`}</span>
        <span className="nx-trow__d">{running ? liveElapsed : (dur && !/^0m?s$/i.test(dur) ? dur : "")}</span>
        <span className={`nx-trow__c${open ? " is-open" : ""}`} aria-hidden="true"><IconChevronRight size={12} /></span>
      </button>
      <SmoothCollapse open={open}><div className="nx-tgroup__body">{rows}</div></SmoothCollapse>
    </div>
  );
});
FlatActivityRow.displayName = "FlatActivityRow";

export default ActivityRow;
