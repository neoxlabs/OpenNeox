/* Agent Timeline 数据结构 · v4 · tool-call feed + 消息 row */
import type { TimelineErrorActionKind } from '../../utils/workspaceUtils';
import type { DataRecord } from './dataResult';

export type StepStatus = 'done' | 'running' | 'pending' | 'failed' | 'awaiting' | 'interrupted';

export type StepIconKind =
  | 'thinking' | 'task' | 'project'
  | 'file' | 'terminal' | 'web'
  | 'read' /* 读取文件 — 摊开的书 */
  | 'folder' /* 列目录 / 看树 — 文件夹 */
  | 'generate' | 'edit' | 'test' | 'summary'
  | 'search' | 'database'
  | 'retry' /* 重连 / 限流 / 超时 等中间态 — 线性循环箭头 */
  | 'diff' /* 「本轮改动」汇总卡 — 铅笔, 不跟 log/cron 共用那个时钟 */
  | 'skill' /* use_skill 卡 — 书本/spark 复合 glyph, 跟 IconLayers 区分 */
  | 'computer' /* Computer Use — 显示器, 跟终端(命令)/浏览器(网页)分开 */
  | 'plugin';

export type TimelineDensity = 'normal' | 'minimal' | 'debug';
export type TimelineNodePhase = 'entering' | 'active' | 'settling' | 'completed' | 'failed' | 'awaiting';
export type TimelineNodeImportance = 'primary' | 'secondary' | 'debug';
export type TimelineContentVisibility = 'inline' | 'collapsed' | 'expanded' | 'summary';

export interface TimelinePresentation {
  /** Row 生命周期阶段: 给动画 / 状态文案 / 自动折叠统一使用. */
  phase: TimelineNodePhase;
  /** 信息重要度: normal/minimal/debug density 下决定显隐和强调程度. */
  importance: TimelineNodeImportance;
  /** 内容展示策略: inline=消息/核心结果, expanded=展开, collapsed=收起, summary=只显摘要. */
  visibility: TimelineContentVisibility;
  /** 兼容现有 TimelineStep 展开状态, 新代码应优先读 presentation.visibility. */
  defaultExpanded: boolean;
  /** 从 active 到完成后的稳定窗口, 避免刚结束就闪折叠. */
  settleDelayMs?: number;
  /** 完成后自动折叠的延迟. 用户手动展开/收起后不再自动改. */
  collapseAfterCompleteMs?: number;
  /** 可显示在 row 上或 tooltip 的摘要, 后续 minimal mode 复用. */
  summary?: string;
  /** visible UI 是否隐藏秒数, 秒数仍可留在 title/debug. */
  suppressDuration?: boolean;
}

/* ============================================================
 * 通用子结构
 * ============================================================ */

export interface CodeLine {
  kind?: 'prompt' | 'comment' | 'normal';
  text: string;
}

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'gap' | 'more';
export interface DiffLine {
  kind: DiffLineKind;
  oldNo?: number;
  newNo?: number;
  text: string;
}

export interface SearchHit {
  file: string;
  line?: number;
  text: string;
}

export type PlanItemStatus =
  | 'pending' | 'in_progress' | 'completed'
  | 'failed' | 'skipped' | 'blocked' | 'verifying';

export interface PlanStepRow {
  id: string;
  content: string;
  status: PlanItemStatus;
  priority?: string;
  /** 标准阶段 (work:Q-09): 读材料 / 核对 / 产出 / 自检. 缺省 = 模型没标 */
  phase?: string;
  /** 预计耗时秒数 (work:Q-07) */
  estimateSec?: number;
}

/* ============================================================
 * 专属 step content — 按 tool 类型分流
 *   - diff        (edit_file)
 *   - terminal    (execute_bash / execute_shell)
 *   - search      (grep / search_files)
 *   - plan        (plan / plan_update)
 *   - thinking    (reasoning 文本)
 *   - error       (tool_error / runtime 错误)
 *   - code        (fallback: 任意 tool_result 的通用文本输出)
 * ============================================================ */
export interface AskUserOption {
  label: string;
  description?: string;
}
export interface AskUserQuestion {
  question: string;
  options: AskUserOption[];
  answer?: string;
}

export interface WebResult {
  title: string;
  url?: string;
  snippet?: string;
}

export type StepContent =
  | {
      type: 'office';
      kind: 'sheet';
      file?: string;
      sheet?: string;
      /** 改了的格子: A1 地址 → 新值 (公式原样) */
      cells: Array<{ addr: string; value: string }>;
    }
  | {
      type: 'office';
      kind: 'doc';
      file?: string;
      /** 段落号 (0 起), 整段改写 / 插入时有 */
      paragraph?: number;
      before?: string;
      after: string;
    }
  /* 设计稿「全部工具」里那批卡 (演示稿 / 分享 / 视频 / 团队 / 日程 / 测试 …), 数据和画法都在 toolCards/ */
  | { type: 'tool_card'; card: import('./toolCards/toolCardTypes').ToolCard }
  /* generate_image / edit_image 的结果 —— timeline 上直接看到图, 不用去翻文件夹。
   * 走 neox-asset:// 协议显示 (electron/main.ts 的 protocol.handle, 放行 workspace
   * 各根 + artifacts 目录), 生图正好落在 workspace 里。 */
  | {
      type: 'image';
      /** 生成出来的图片绝对路径 */
      paths: string[];
      prompt?: string;
      model?: string;
      /** 命中持久缓存 (0 秒 0 费用) —— 值得让用户看见 */
      cached?: boolean;
    }
  /* 模型看过的图 (读图片 / PDF 页 / 浏览器截图 …)。宿主把 base64 落到 ~/.neox/run/seen/,
   * 这里只拿路径 —— 用户要看见的就是模型刚看见的那张。 */
  | {
      type: 'seen_images';
      images: Array<{ path: string; label?: string }>;
    }
  | { type: 'none' }
  /* 插件 / MCP 工具返回的结构化数据 (JSON) —— 解析成记录列表或键值, 不再把
   * 200 行缩进 JSON 原样摊在 timeline 上。原文收在「原始数据」里。见 dataResult.ts。 */
  | {
      type: 'data';
      /** 记录列表 (数组结果, 或对象里最主要的那个数组字段) */
      records?: DataRecord[];
      /** 记录总数 —— records 只取前若干条, 这里是真实条数 */
      total?: number;
      /** 对象结果的标量字段 (或记录列表之外的顶层标量) */
      fields?: Array<{ k: string; v: string }>;
      /** 原始 JSON 文本 (已缩进), 展开「原始数据」时显示 */
      raw: string;
    }
  | {
      type: 'code';
      lines: CodeLine[];
      progress?: number;        // 0-100
      progressText?: string;
      /** Surface tool 专用 — open_surface / update_surface 命中时塞这个, TimelineStep 渲染时
       * 知道这条 code 卡片对应一个可点回右侧的 Surface, 加 "右侧重新打开" 按钮 (走 surfaceStore
       * setActiveSurface). title 给按钮 tooltip 用. */
      surfaceRef?: { surfaceId: string; kind: string; title?: string };
      isBrowser?: boolean;
    }
  | {
      type: 'diff';
      file: string;
      addCount: number;
      delCount: number;
      lines: DiffLine[];
      streaming?: boolean;
      /** edit hunks 原始数据 — 让 FilePathChip 点击 surface 时透传给 CodeSurfaceViewer
       *  切到 Monaco DiffEditor 模式显示双栏老/新 diff. */
      editHunks?: Array<{
        oldString?: string;
        newString?: string;
        startLine?: number;
        oldLineCount?: number;
        newLineCount?: number;
        oldCharCount?: number;
        newCharCount?: number;
        previewTruncated?: boolean;
      }>;
      fallbackContent?: string;
      /** write_file 整文件覆盖前存的原内容快照 id — 这类改动没有 old/new hunk, 内容级 Undo
       *  走不通, 只能靠它还原。见 neox-core/tools/files/fileSnapshotStore.ts。 */
      previousSnapshotId?: string;
      /** Coalesce 合并的 entry 数量 (Cursor 风格 — 同 turn 同 filePath 合一张卡).
       *  > 1 时 filehead 显示 "(N 次操作)" 角标, 让用户知道这张卡内是聚合视图. */
      coalescedCount?: number;
    }
  | {
      type: 'terminal';
      command?: string;
      output?: string;
      exitCode?: number;
      streaming?: boolean;
      /** entry.toolCallId — TerminalView 用它订阅 terminalChunkBus, 接 xterm 字节流 */
      toolId?: string;
      /** PTY child pid — xterm onData/onResize 反向调 (shellStdin / shellResize) 用 */
      pid?: number;
      /** 前台跑久了 / 用户插话, 命令转到后台继续跑 —— 工具调用结束了, 命令没结束, 不能写 exit 0 */
      backgrounded?: boolean;
    }
  | {
      type: 'search';
      pattern?: string;
      totalHits?: number;
      hits?: SearchHit[];        // 最多展示 6-8 条, 剩下折 "+N more"
      /** 真实工具名 (search / grep / search_files / glob …) —— Explore 卡以前写死 'grep',
       *  于是 search 也被标成 grep。别再猜, 按实际调的那个显示。 */
      tool?: string;
    }
  | {
      type: 'plan';
      goal?: string;
      steps: PlanStepRow[];
      /** update_plan 落盘后的 .neox/plans/${sessionId}.md 路径 — 给 FilePathChip 用,
       * 让用户点击就能在 Surface 预览 / 编辑器打开当前 plan markdown. */
      planPath?: string;
      frozen?: boolean;
    }
  | {
      type: 'thinking';
      text: string;
    }
  | {
      type: 'error';
      code?: string;
      message: string;
      suggestion?: string;
      /** 同一轮里同一个错误又发生了几次 (点重试再失败) — 卡片原地更新, 不再堆一张新的。 */
      repeatCount?: number;
      /** 最近一次发生的时刻 (HH:MM, 已格式化)。原地更新时卡片位置/时间戳都不动,
       *  少了这个用户看不出"又失败了一次"。 */
      lastAt?: string;
      /** 引导用户的 CTA 按钮 — 来自 NeoxError catalogue.action. autoTrigger=true 的不该到这里 (handleErrorClassified 已静默执行). */
      action?: {
        kind: TimelineErrorActionKind;
        label: string;
        url?: string;
      };
      /** 网关 request id (= request_logs.request_id) — 报障时唯一能查到库的键. */
      requestId?: string;      /** 同上: 浏览器工具的失败也走 BrowserResultView, 别用标题前缀判。 */
      isBrowser?: boolean;

    }
  | {
      type: 'readfile';
      file: string;
      totalLines?: number;
      offset?: number;
      limit?: number;
      preview?: CodeLine[];      // 截断前 N 行
      displayFile?: string;
      fileName?: string;
      directory?: string;
      language?: string;
    }
  | {
      type: 'askUser';
      requestId?: string;
      status: 'waiting' | 'answered' | 'timeout' | 'interrupted';
      questions: AskUserQuestion[];
      /** 服务重启 + 磁盘记录都没了, 答案丢失. UI 渲染红条 + "改用消息发送" 入口. */
      error?: string;
      attemptedAnswers?: Record<string, string>;
      createdAt?: number;
      timeoutSec?: number;
    }
  | {
      type: 'web';
      kind: 'search' | 'fetch';
      query?: string;
      url?: string;
      results?: WebResult[];
      bytes?: number;
      /** search: 一共搜到几条 (results 只留前 8 条展示)。 */
      total?: number;
    }
  | {
      type: 'compaction';
      status?: 'started' | 'compressing' | 'completed' | 'failed' | 'skipped';
      originalTokens?: number;
      finalTokens?: number;
      budgetTokens?: number;
      originalMsgs?: number;
      keptMsgs?: number;
      droppedMsgs?: number;
      compressionBuckets?: Array<{
        bucket: string;
        label: string;
        messageCount: number;
        estimatedTokens: number;
        status: string;
        compressedTokens?: number;
        items?: string[];
      }>;
      compressionTotalBuckets?: number;
      compressionCompletedBuckets?: number;
      compressionSummaryModel?: string;
      /** 失败原因原文 (status=failed 时) —— 分割线下方整段显示, 不折叠 */
      errorDetail?: string;
    }
  | {
      type: 'target_continuation';
      iteration?: number;
      consecutiveBlocks?: number;
      kind?: 'target' | 'verify' | 'team_spec' | 'unfinished' | 'plan';
    }
  | {
      type: 'worker';
      agentId?: string;
      role?: string;
      model?: string;
      task?: string;
      status?: 'running' | 'completed' | 'failed';
      summary?: string;
      error?: string;
    }
  | {
      type: 'delegation';
      role?: string;
      roleName?: string;
      model?: string;
      task?: string;
      status?: 'running' | 'completed' | 'error';
      summary?: string;
      error?: string;
      toolCount?: number;
      currentStatus?: string;
      /** true = 后台 agent — DelegationView 加 "后台" badge 提示用户它还在跑 */
      isBackground?: boolean;
      /** task-agent 内部跑过的工具序列, 卡片体里展开列出 */
      toolRecords?: Array<{
        name: string;
        args?: string;
        status: 'running' | 'done' | 'error';
        duration?: number;
      }>;
    }
  | {
      /** 派给本机其它 agent CLI (Codex / Claude Code) 的任务 */
      type: 'external_agent';
      agentId: string;
      displayName?: string;
      task?: string;
      status?: 'running' | 'completed' | 'error';
      summary?: string;
      error?: string;
      toolCallId?: string;
      elapsedMs?: number;
      /** true = 已转后台, 主对话不再等它 */
      isBackground?: boolean;
      branch?: string;
      changedFiles?: string[];
    }
  | {
      type: 'explore';
      role?: string;
      task?: string;
      status?: 'running' | 'completed' | 'error';
      summary?: string;
      error?: string;
      toolCount?: number;
      tokens?: number;
      elapsed?: number;      // ms
      currentStatus?: string;
      toolRecords?: Array<{
        name: string;
        /** 并行模式下用来按 agent 分组渲染, 单 agent 时缺省 */
        agentId?: string;
        args?: string;
        status: 'running' | 'done' | 'error';
        duration?: number;
        resultHint?: string;
      }>;
      /** ×N 并行 explore — 每个 agent 一行 + 嵌套自己的 toolRecords */
      groupMembers?: Array<{
        agentId: string;
        task: string;
        model?: string;
        status: 'running' | 'completed' | 'error';
        toolCount: number;
        tokens: number;
        iterations?: number;
        tokensEstimated?: boolean;
        startedAt?: number;
        elapsed: number;
      }>;
    }
  | {
      type: 'dag';
      id?: string;
      description?: string;
      nodeCount?: number;
      completedNodes?: number;
      failedNodes?: number;
      nodes?: Array<{
        id: string;
        name: string;
        status: 'pending' | 'running' | 'completed' | 'failed';
        agentId?: string;
        duration?: number;
      }>;
    }
  | {
      type: 'filelist';
      root?: string;
      entries: Array<{
        path: string;
        isDir: boolean;
        depth?: number;    // tree 缩进级
        size?: number;
      }>;
      total?: number;
    }
  | {
      type: 'log';
      level?: 'info' | 'warning' | 'error';
      message: string;
    }
  | {
      type: 'change';
      items: Array<{ label?: string; before?: string; after?: string }>;
      /** items 只取前几条, 这里是没列出的条数 */
      more?: number;
    }
  | {
      type: 'network';
      variant:
        | 'bidding' | 'agent_bid'
        | 'negotiation' | 'negotiation_message'
        | 'dag_topology' | 'replan'
        | 'task_analysis' | 'agent_execution' | 'mode_select';
      label: string;                       // e.g. "BIDDING"
      tone?: 'primary' | 'ok' | 'warn' | 'err';
      fields?: Array<{ k: string; v: string | number; highlight?: boolean }>;
      list?: Array<{ main: string; sub?: string; badge?: string }>;
      extra?: string;                      // 长文本 (content / reason / output)
    }
  | {
      /** schedule_wakeup — agent 自主 pacing 卡片. 三个分支:
       *   · scheduled: 成功登记, 显示倒计时 + due_at + reason + prompt
       *   · skipped:   非错误的"环境不支持"(如 no_active_session), 折叠提示
       *   · invalid:   参数缺失等校验失败, 显示错误说明 */
      type: 'wakeup';
      status: 'scheduled' | 'skipped' | 'invalid';
      reason?: string;             // agent 自己写的 reason
      prompt?: string;              // 唤醒时的指令
      delaySeconds?: number;        // effective_delay_seconds
      dueAtMs?: number;             // 绝对时间 (ms epoch)
      dueAtIso?: string;            // ISO 字符串方便显示
      clamped?: boolean;            // 是否被 clamp 到 [60, 3600]
      message?: string;             // skipped/invalid 的解释
    }
  | {
      /** timer_card — 通用"定时/预约"卡, 复用给 reminder / cron / 未来任何"我到 X 时刻做 Y"类工具.
       *   subKind 让样式微调 (icon / 色调), body 结构统一: 标题 · 何时 · 状态 · 可选副文.
       *   scheduled=已挂载, fired=到点触发, done=真完成, canceled=取消. */
      type: 'timer_card';
      subKind?: 'reminder' | 'cron' | 'wakeup' | 'other';
      status: 'scheduled' | 'fired' | 'done' | 'canceled';
      title: string;
      context?: string;
      atText?: string;             // "5:20 PM" / "7/11 8am" 已格式化
      recurrence?: string;         // once/daily/weekly/monthly/cron...
    }
  | {
      /** neox_card — 复用回答区的富卡组件 (NeoxCards.tsx) 渲染工具结果.
       *   get_weather 的 raw JSON 直接喂 weather 卡; 未来 booking/tracking 类
       *   工具结果同路. kind 走 NeoxCard 白名单, body 是卡片 JSON 字符串. */
      type: 'neox_card';
      kind: 'restaurant' | 'weather' | 'todo' | 'compare' | 'news' | 'booking' | 'recipe' | 'tracking' | 'trip' | 'product' | 'gallery';
      body: string;
    }
  | {
      type: 'skill';
      skillId: string;
      skillName: string;
      trustLevel?: 'trusted' | 'limited';
      /** allowedTools = skill 声明的可用工具白名单 (limited trust 强制执行). */
      allowedTools?: string[];
      /** model = skill 声明的模型覆盖 (可选). */
      model?: string;
      /** SKILL.md 全文 (含 model/tool notice 段). */
      body: string;
      /** save_skill 存下来的 (10-21): 有这个就画「已存成技能」卡, 不画用技能卡 */
      saved?: { description?: string; whenToUse?: string; scope?: 'user' | 'workspace'; path?: string; steps?: number };
    }
  | {
      type: 'deep_research';
      topic: string;
      scale: string;
      /** 'running' = 调研还在跑的活卡 (数据来自 research_progress 事件);
       *  'done'/缺省 = 收工后的结果卡 (数据来自 output.metadata)。
       *  同一个 type 两副相: 卡片就地变身, 而不是收工时换一张新卡 ——
       *  mapTimelineToRows / timelinePresentation / TimelineStep / timelineRows
       *  都已经按 'deep_research' 这个名字配好了, 换名字等于那几处全要再写一遍。 */
      phase?: 'running' | 'done';
      /** 活卡用: 开跑时刻, 卡头那个计时器从这里算 */
      startedAt?: number;
      /** 活卡用: 一连串调研员各自到哪了 —— 用户要的「看得见几个 Agent 在干活」 */
      workers?: Array<{
        id: string;
        question: string;
        status: 'queued' | 'running' | 'done' | 'failed';
        summary?: string;
        toolCount?: number;
        tokens?: number;
        currentTool?: string;
      }>;
      /** 活卡用: 各路 token 合计, 卡头显示 */
      totalTokens?: number;
      interrupted?: boolean;
      /* 下面这些只有结果卡有 —— 活卡跑的时候还没有, 所以一律可选。 */
      stopReason?: string;
      dispatched: number;
      leaderModel?: string;
      workerModel?: string;
      modelKind?: string;
      reportPath?: string;
      stats: {
        sources: number;
        domains: number;
        claims: number;
        singleSource: number;
        disputed: number;
        /* 这三个只有结果卡算得出 */
        supported?: number;
        unverified?: number;
        archivedChars?: number;
      };
      domains: string[];
      disputes: Array<{
        cid: string;
        text: string;
        support: { sid: string; host: string; quote: string };
        contradict: { sid: string; host: string; quote: string };
        lean?: string;
        /** false = 同一来源内部的自我限定, 不是两家说法不一 */
        crossSource?: boolean;
      }>;
      unexplored: string[];
    }
  | {
      type: 'computer';
      app?: string;
      /** data:image/png;base64,… (os-bridge 的 icon op) */
      icon?: string;
      steps: Array<{ text: string; ok?: boolean; ms?: number; error?: string; note?: string }>;
      /** 窗口截图的本地路径 */
      screenshot?: string;
      totalMs?: number;
      ok?: boolean;
      note?: string;
    }
  | {
      type: 'browser';
      /** 域名 (从第一个 navigate 或最终落点取) */
      site?: string;
      url?: string;
      steps: Array<{ text: string; ok?: boolean; ms?: number; error?: string; note?: string }>;
      /** 失败时的页面截图 (本地路径) */
      screenshot?: string;
      totalMs?: number;
      note?: string;
      signals?: { consoleErrors?: number; failedRequests?: number; apiCalls?: number };
    }
  | {
      /** instructions — 项目指令 (NEOX.md / .neox/INSTRUCTIONS.md) 加载卡.
       *   跟 skill 卡同一档视觉: 加载本身是 agent 的一个可观测动作, 走工具卡片渲染,
       *   不另立 status 栏 —— 有这张卡 = 指令生效了, 没卡 = 没生效.
       *   刻意不显 contentHash: 内部细节, 用户不关心. */
      type: 'instructions';
      /** 会话工作区根 —— 卡片上用于把绝对路径缩成相对路径. */
      workspace: string;
      /** 加载成功的文件: 从哪来 (level) + 多大 (lines). */
      sources: Array<{ path: string; level: 'workspace' | 'parent' | 'user'; lines: number }>;
      /** 读失败的文件 (不含 ENOENT —— "没有这个文件" 是正常态, 根本不会走到这张卡). */
      failures: Array<{ path: string; code: string; message: string }>;
      /** 合并后指令总字符数. */
      chars: number;
    }
  | {
      /** op_chip — 通用紧凑卡片, 给短状态切换 / 简单文件操作 / 终止进程等用.
       *   一行渲染: icon + label + target + tone 配色, 比 code dump 干净.
       *   覆盖: enter_plan_mode / exit_plan_mode / enter_worktree / exit_worktree /
       *         delete_file / rename_file / create_directory / bash_kill /
       *         cron_create / cron_delete / task_create / task_update / task_stop. */
      type: 'op_chip';
      icon?: string;                                  // emoji / 单字符, 默认按 tone 选
      label: string;                                  // 动作描述: "进入计划模式" / "删除文件" / "停止进程"
      target?: string;                                // 关联对象: 路径 / 分支名 / pid / cron 表达式
      hint?: string;                                  // 次要说明 (可选), 灰色小字
      tone?: 'primary' | 'ok' | 'warn' | 'err' | 'plain';
      /** delete_file 删除前存的内容快照 manifest id —— 有它才渲染"撤销删除". */
      deletionSnapshotId?: string;
    }
  | {
      /** turn_summary — 一轮 (user_message → run_result) 内所有文件改动的紧凑列表卡.
       *  每条 file row: FilePathChip (点击 → openSurfaceFromPath + 行高亮) + ±diff 统计.
       *  rename 显示 from→to. */
      type: 'turn_summary';
      turnId?: string;
      totalFiles: number;
      totalAdds: number;
      totalDels: number;
      changes: Array<{
        path: string;
        op: 'edit' | 'write' | 'delete' | 'rename';
        addCount: number;
        delCount: number;
        changedLines?: Array<{ start: number; end: number; kind: 'add' | 'del' | 'modify' }>;
        from?: string;
        editHunks?: Array<{
          oldString?: string;
          newString?: string;
          startLine?: number;
          oldLineCount?: number;
          newLineCount?: number;
          oldCharCount?: number;
          newCharCount?: number;
        }>;
        fallbackContent?: string;
        /** op='write' 但改写的是已有文件 —— 不标「新建」 */
        overwrote?: boolean;
      }>;
    }
  | {
      /** context_status — agent 自查预算卡片. snapshot 不在时降级显示 advice */
      type: 'context_status';
      suggestion: 'ok' | 'save_memory_soon' | 'save_memory_and_restart' | 'unknown';
      advice?: string;
      snapshotAvailable: boolean;
      sessionId?: string;
      worstPct?: string;           // e.g. "42%"
      input?:  { used: number; budget: number; pct: string; compressAt?: number };
      output?: { used: number; budget: number; pct: string };
      toolCalls?: { used: number; budget: number };
      time?:    { elapsedMs: number; budgetMs?: number };
      turns?:   { llmCalls: number; toolCallsTotal: number };
    }

  | {
      type: 'readdoc';
      status: string;
      fileName?: string;
      chars?: number;
      sizeLabel?: string;
    }
  | {
      /** target_op — Target Mission 相关工具展示卡.
       *   活跃 target 的四个工具: activate_target / plan_target / check_target_done / abandon_target.
       *   样式对齐 .atl-explore (中性淡色背景, 无 border, 铺满宽度, radius 8),
       *   避免 op_chip 紫框 inline-flex 的视觉侵入感. */
      type: 'target_op';
      variant: 'activate' | 'plan' | 'done_true' | 'done_false' | 'abandon';
      /** 主标题 label, 例如 "激活 Target" */
      label: string;
      /** 目标文本 (完整, 不 slice) */
      target?: string;
      /** 说明: rationale (activate) / reason (check_target_done) */
      note?: string;
      /** plan_target 的 sub-mission 数 (给 chip 用) */
      subMissionCount?: number;
      /** plan_target 完整战略块列表 — 渲染成节点列表 + 每块状态, 让用户看清拆了哪几块、干到哪 */
      subMissions?: Array<{
        id: string;
        description: string;
        successCriteria?: string;
        status?: 'pending' | 'in_progress' | 'completed';
      }>;
      /** 已完成战略块数 — 卡片 chip 显示 "已完成/总数 块" */
      completedSubMissions?: number;
      /** 语义 tone: primary / ok / plain / err */
      tone: 'primary' | 'ok' | 'plain' | 'err';
    };

/* ============================================================
 * TimelineItem — union: tool step 或 message 消息行
 * ============================================================ */

export interface TimelineStep {
  kind?: 'tool';
  id: string;
  title: string;
  desc?: string;
  status: StepStatus;
  iconKind: StepIconKind;
  /** 连接器 / 委派插件的官方 logo URL。有它时行首用真 mark, 不用线性 glyph。 */
  brandIcon?: string;
  tone?: 'busy' | 'benign';
  /** 被守卫拦下 (loop/permission/risk/guardrail) —— 不参与同类聚合, 那句提示要看得见 */
  blockedBy?: string;

  timestamp?: string;
  duration?: string;
  /** 原始开始时间 (ms). running 状态时用于实时显示 elapsed 计数 */
  startedAtMs?: number;

  content?: StepContent;
  defaultExpanded?: boolean;
  presentation?: TimelinePresentation;

  /** row 右侧渲染的小 meta chip: 例如 ["+3 −2", "12 命中"] */
  meta?: string[];

  /** row 右侧彩色 diff 统计 (+N / −N), 只对 diff content 有意义 */
  diffStat?: { add: number; del: number };

  /** 同 groupId 相邻 step 聚合为 parallel group */
  groupId?: string;
  groupLabel?: string;
}

export interface MessageAttachment {
  id: string;
  kind: 'image' | 'file' | 'url';
  name?: string;
  path?: string;
  /** image 是 data URL 或 http(s) URL, file 是文本片段 */
  data?: string;
  size?: number;
  language?: string;
}

export interface TimelineMessage {
  kind: 'message';
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
  /** 原始时间 (ms) —— timestamp 是给人看的「20:10」, 解析不回来; 算这一轮工作了多久要用它 */
  timestampMs?: number;
  streaming?: boolean;
  attachments?: MessageAttachment[];
  source?: string;
  injectionPending?: boolean;
  /** 本轮消耗 token (消息定稿时快照, 见 useStreamHandler 的 turnUsageRef) */
  turnTokens?: number;
  /** 本轮用量明细 — 点击 footer「共消耗」展开 (输入 / 缓存 / 输出) */
  turnUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  };
  /** 生成这条回复的模型 */
  model?: string;
  /** 本轮生成速度 tok/s (总输出 ÷ 总生成时长, 不含工具执行时间) */
  turnTps?: number;
}

export type TimelineItem = TimelineStep | TimelineMessage;

/* ============================================================
 * TimelineRow v2 (Phase 3.12 起的新 row 顶层 union)
 *
 *   设计文档 内部设计文档 §6.2
 *   HistoryCell.ts:48-260 标了每个 cell 对应原 buildXxxContent 函数行号.
 *
 *   双轨过渡期 (Phase A-C):
 *   - 老 TimelineItem 路径仍在跑 (mapTimelineEntries / TimelineSteps / RowContent)
 *   - 新 TimelineRow 路径并行落地, mapTimelineEntriesToRows + HistoryCellRenderer 喂 cells/
 *   - 12 个 covered StepContent.type 走 HistoryCellRow (cell 字段直接来自 mapTimeline)
 *   - 7 个 uncovered (op_chip / context_status / dag / network / filelist / readdoc /
 *     turn_summary) 走 LegacyStepRow 包老 TimelineStep (HistoryCell.ts:262-274 设计意图)
 *
 *   Phase E 收尾时 TimelineItem 拆掉, TimelineRow 成唯一 row 抽象.
 * ============================================================ */

import type { HistoryCell } from './cells/HistoryCell';

/**
 * HistoryCellRow — 12 covered HistoryCell kind 的 row 包装.
 *   cell 是渲染 payload (HistoryCellRenderer 按 cell.kind 分发).
 *   其余字段是 row 级别 UX (TimelineStep 包装层用): 状态 / icon / 标题 / 折叠 / 分组.
 *
 *   注: cell.kind === 'user' / 'assistant_text' 时 status/iconKind/title/desc 等没意义,
 *   渲染层会跳过 TimelineStep 包装直接渲染 message row (MessageCell 等).
 */
export interface HistoryCellRow {
  kind: 'cell';
  cell: HistoryCell;
  id: string;
  status: StepStatus;
  /** 语气覆盖, 跟 TimelineStep.tone 同义 —— 这条链上 step 被逐字段重建两次, 漏传就等于没有. */
  tone?: 'busy' | 'benign';
  /** 被守卫拦下, 跟 TimelineStep.blockedBy 同义 (同上: 漏传 = 折叠豁免不生效) */
  blockedBy?: string;
  iconKind: StepIconKind;
  brandIcon?: string;
  title: string;
  desc?: string;
  timestamp?: string;
  duration?: string;
  startedAtMs?: number;
  meta?: string[];
  diffStat?: { add: number; del: number };
  presentation: TimelinePresentation;
  defaultExpanded?: boolean;
  groupId?: string;
  groupLabel?: string;
  /* legacyContent — TimelineStep 边界过渡字段 (HistoryCellRenderer 不读, cells/ 数据自洽).
   *   rowStepToTimelineStep 用它给 TimelineStep.tsx 合成 step.content, 让
   *   askUser waiting 检测 / terminal pid / error message / hasContent 等 step.content 派生
   *   逻辑继续工作. 待 TimelineStep 改为直接消费 HistoryCell 后整体删除. */
  legacyContent?: StepContent;
}

/**
 * LegacyStepRow — 7 个 HistoryCell 未覆盖的 StepContent.type 用.
 *   完全复用现有 TimelineStep 结构 + StepContentRenderer 老路径,
 *   不强行塞进 HistoryCell 13 union (HistoryCell.ts:262-274 明说不补).
 */
export interface LegacyStepRow {
  kind: 'legacy_step';
  step: TimelineStep;
}

export type TimelineRow = HistoryCellRow | LegacyStepRow;

/* ============================================================
 * TimelineTask — Header meta
 * ============================================================ */
export interface TimelineTask {
  title: string;
  subtitle?: string;
  elapsedText: string;
  running: boolean;
  items: TimelineItem[];
}
