
export interface KV { k: string; v: string }

export type ToolCard =
  /* 演示稿: 一排页面缩略 (只画标题 + 版式提示, 不渲染真页面) */
  | { kind: 'slides'; file?: string; total?: number; added?: number; slides: Array<{ title: string; layout?: string }> }
  /* 读文档 / 看表格: 一行事实, 没有卡身 */
  | { kind: 'read_doc'; file: string; pages?: string; totalPages?: number; sheet?: string; rows?: number; cols?: number; chars?: number }
  /* 分享网页: 链接卡 + 复制 / 打开 */
  | { kind: 'link'; url: string; title?: string; access?: string; expires?: string }
  /* 做视频: 封面 + 播放键 + 时长 */
  | { kind: 'video'; path: string; title?: string; duration?: string; resolution?: string }
  /* 改图: 原图 → 结果 */
  | { kind: 'image_edit'; before: string; after: string[]; instruction?: string }
  /* 团队: 成员并排 (头像字 · 名字 · 在干什么 · 状态) */
  | { kind: 'team'; name?: string; members: Array<{ name: string; action?: string; state: 'running' | 'done' | 'failed' | 'idle' }> }
  /* 发给队友一句话 */
  | { kind: 'team_message'; to: string; text: string }
  /* 日程: 日期方块 + 标题 + 时间 / 地点 / 邀请 */
  | { kind: 'calendar'; title: string; start: string; end?: string; location?: string; invitees?: number; allDay?: boolean }
  /* 发消息: 一颗蓝气泡 + 时间 · 状态 */
  | { kind: 'message'; to: string; text: string; channel?: string; status?: string; at?: string }
  /* 方案: 蓝边卡, 编号步骤, 底部「改一下 / 按这个做」 */
  | { kind: 'plan'; title?: string; steps: string[]; files?: number; awaiting?: boolean }
  /* 资料库: 命中的片段, 关键词高亮 */
  | { kind: 'knowledge'; query: string; hits: Array<{ title: string; snippet: string; where?: string }> }
  /* 记忆: 一行 —— 记住了 / 想起来 */
  | { kind: 'memory'; op: 'save' | 'recall'; text: string; scope?: string; count?: number }
  /* 测试结果条 + 失败用例 */
  | { kind: 'tests'; passed: number; failed: number; skipped?: number; durationMs?: number; failures: Array<{ name: string; expected?: string; actual?: string; message?: string }>; raw?: string }
  /* Git 状态: 分支 + 改动文件 */
  | { kind: 'git_status'; branch?: string; ahead?: number; behind?: number; files: Array<{ status: string; path: string }> }
  /* 查来历 / 提交记录 */
  | { kind: 'git_log'; items: Array<{ hash: string; title: string; author?: string; when?: string }> }
  /* 找引用 / 查问题 */
  | { kind: 'refs'; symbol?: string; items: Array<{ file: string; line?: number; tag?: 'def' | 'call' | 'ref'; text?: string }> }
  | { kind: 'diagnostics'; items: Array<{ file: string; line?: number; severity: 'error' | 'warning' | 'info'; message: string; rule?: string }> }
  /* 启动服务: 地址 · pid */
  | { kind: 'service'; name: string; url?: string; pid?: number; status: 'running' | 'stopped' | 'failed' }
  /* 执行 Python: 代码 + 输出 (+ 图) */
  | { kind: 'python'; code: string; stdout?: string; images?: string[] }
  /* 定时 / 提醒: 一行 */
  | { kind: 'schedule'; what: string; when: string; next?: string }
  /* 天气 / 路线 */
  | { kind: 'route'; from?: string; to?: string; minutes?: number; summary?: string; detail?: string }
  /* 找工具: 一排工具名小签 */
  | { kind: 'tool_search'; tools: string[] }
  /* MCP 调用: 参数 / 结果按键值列, 原始 JSON 收起 */
  /** text: 结果是文字时的正文 (大多数 MCP 回的是一段文字 / markdown, 不是 JSON 对象) */
  | { kind: 'mcp'; server?: string; tool: string; params: KV[]; result: KV[]; text?: string; raw?: string }
  /* ── 10-21 补齐 (画法在 ExtraCardViews.tsx, 解析在 extraParsers.ts) ── */
  /* 提交: hash · 说明 · 分支 · 改动数 */
  | { kind: 'commit'; hash?: string; message: string; branch?: string; files?: number; insertions?: number; deletions?: number }
  /* 建分支: 一行 */
  | { kind: 'branch'; name: string; checkout?: boolean }
  /* 查来历: 每行是谁哪天改的 */
  | { kind: 'blame'; file: string; rows: Array<{ line: number; hash: string; author: string; date: string; code: string }> }
  /* 盯日志 / 盯命令 */
  | { kind: 'monitor'; op: 'start' | 'stop' | 'list'; watching?: string; id?: string; items?: Array<{ watching: string; fires?: string }> }
  /* 上下文用量 */
  | { kind: 'context'; pct: number; used?: number; budget?: number; compactAt?: number; advice?: string };

export type ToolCardKind = ToolCard['kind'];

/** 本身就是答案的卡 (日程 / 路线 / 分享链接 / 视频 / 改图): 这一轮做完折叠时留在外面,
 *  不收进「做好了 · N 步」—— 跟天气 (neox_card) 同档, 折进去就只剩一段文字。 */
const ANSWER_KINDS = new Set<ToolCardKind>(['calendar', 'route', 'link', 'video', 'image_edit']);
export function isAnswerToolCard(content: { type?: string; card?: { kind?: string } } | undefined): boolean {
  return content?.type === 'tool_card' && ANSWER_KINDS.has(content.card?.kind as ToolCardKind);
}
