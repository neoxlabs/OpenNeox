/**
 * Schema V2 + V3 — Agent OS + Steward + ActionLog 持久化表
 *
 * V2: agents, agent_progress, agent_messages, teams, tasks
 * V3: steward_*, team_sessions, actionlog_*, session_items
 * 所有表都有 workspace_path 做项目级隔离
 */

export const AGENT_SCHEMA_VERSION = 2;

export const AGENT_SCHEMA_SQL = `
-- =====================================================
-- Schema Version 2: Agent OS 持久化
-- =====================================================

-- 1. agents — 所有 Agent 实例（Worker / Leader / Main）
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  session_id      TEXT,
  team_id         TEXT,
  parent_id       TEXT,
  role            TEXT NOT NULL DEFAULT 'developer',
  type            TEXT NOT NULL DEFAULT 'worker',
  task            TEXT NOT NULL,
  context         TEXT,
  state           TEXT NOT NULL DEFAULT 'created',
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  ended_at        INTEGER,
  exit_reason     TEXT,
  output          TEXT,
  error           TEXT,
  tool_calls      INTEGER NOT NULL DEFAULT 0,
  last_tool       TEXT,
  last_output     TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  model           TEXT,
  provider_id     TEXT,
  resumable       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_path);
CREATE INDEX IF NOT EXISTS idx_agents_ws_session ON agents(workspace_path, session_id);
CREATE INDEX IF NOT EXISTS idx_agents_ws_state ON agents(workspace_path, state);
CREATE INDEX IF NOT EXISTS idx_agents_team ON agents(team_id);
CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_id);

-- 2. agent_progress — Agent 中间进度上报
CREATE TABLE IF NOT EXISTS agent_progress (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT NOT NULL,
  workspace_path  TEXT NOT NULL,
  session_id      TEXT,
  phase           TEXT,
  progress_pct    INTEGER,
  message         TEXT NOT NULL,
  details         TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_progress_agent ON agent_progress(agent_id);
CREATE INDEX IF NOT EXISTS idx_progress_ws ON agent_progress(workspace_path);
CREATE INDEX IF NOT EXISTS idx_progress_ws_session ON agent_progress(workspace_path, session_id);

-- 3. agent_messages — Agent 间通信消息记录
CREATE TABLE IF NOT EXISTS agent_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_path  TEXT NOT NULL,
  from_agent_id   TEXT NOT NULL,
  to_agent_id     TEXT,
  team_id         TEXT,
  session_id      TEXT,
  msg_type        TEXT NOT NULL,
  content         TEXT NOT NULL,
  priority        TEXT DEFAULT 'normal',
  delivered       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_msgs_ws ON agent_messages(workspace_path);
CREATE INDEX IF NOT EXISTS idx_agent_msgs_to ON agent_messages(to_agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_msgs_team ON agent_messages(team_id);
CREATE INDEX IF NOT EXISTS idx_agent_msgs_created ON agent_messages(created_at);

-- 4. teams — Team 实例
CREATE TABLE IF NOT EXISTS teams (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  leader_id       TEXT,
  goal            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'leader_managed',
  state           TEXT NOT NULL DEFAULT 'created',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  result          TEXT
);

CREATE INDEX IF NOT EXISTS idx_teams_workspace ON teams(workspace_path);
CREATE INDEX IF NOT EXISTS idx_teams_ws_session ON teams(workspace_path, session_id);
CREATE INDEX IF NOT EXISTS idx_teams_state ON teams(state);

-- 5. tasks — 可恢复的任务定义
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  session_id      TEXT,
  agent_id        TEXT,
  team_id         TEXT,
  title           TEXT NOT NULL,
  description     TEXT,
  state           TEXT NOT NULL DEFAULT 'pending',
  priority        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER,
  result          TEXT,
  parent_task_id  TEXT,
  metadata        TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_path);
CREATE INDEX IF NOT EXISTS idx_tasks_ws_session ON tasks(workspace_path, session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_ws_state ON tasks(workspace_path, state);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_team ON tasks(team_id);

-- 6. agent_snapshots — 暂停/恢复断点快照（🆕 Pause & Resume）
CREATE TABLE IF NOT EXISTS agent_snapshots (
  agent_id        TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  snapshot        TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_ws ON agent_snapshots(workspace_path);

-- 7. team_board_entries — TeamBoard 看板消息持久化（🆕 绑定 session）
CREATE TABLE IF NOT EXISTS team_board_entries (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  pid             TEXT NOT NULL,
  role            TEXT NOT NULL,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  metadata        TEXT,
  reply_to        TEXT,
  channel         TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tb_ws_session ON team_board_entries(workspace_path, session_id);
CREATE INDEX IF NOT EXISTS idx_tb_ws_type ON team_board_entries(workspace_path, session_id, type);
CREATE INDEX IF NOT EXISTS idx_tb_created ON team_board_entries(created_at);
`;

// =====================================================
// Schema V3: JSON/JSONL 全面迁移
// =====================================================

export const SCHEMA_V3_SQL = `
-- -------------------------------------------------------
-- steward_commitments — 承诺/提醒
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS steward_commitments (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  mission_id      TEXT,
  kind            TEXT NOT NULL,
  summary         TEXT NOT NULL,
  source_text     TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  status          TEXT NOT NULL DEFAULT 'active',
  due_at          INTEGER,
  interval_ms     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commitments_ws ON steward_commitments(workspace_path);
CREATE INDEX IF NOT EXISTS idx_commitments_session ON steward_commitments(workspace_path, session_id);

-- -------------------------------------------------------
-- steward_missions — 任务总账
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS steward_missions (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  lane            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'created',
  title           TEXT NOT NULL,
  goal            TEXT NOT NULL,
  source_text     TEXT NOT NULL,
  team_id         TEXT,
  leader_id       TEXT,
  commitments     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_missions_ws ON steward_missions(workspace_path);
CREATE INDEX IF NOT EXISTS idx_missions_session ON steward_missions(workspace_path, session_id);
CREATE INDEX IF NOT EXISTS idx_missions_status ON steward_missions(workspace_path, status);

-- -------------------------------------------------------
-- steward_schedulers — 定时任务
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS steward_schedulers (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  mission_id      TEXT,
  commitment_id   TEXT NOT NULL,
  kind            TEXT NOT NULL,
  summary         TEXT NOT NULL,
  due_at          INTEGER NOT NULL,
  interval_ms     INTEGER NOT NULL DEFAULT 0,
  last_tick_at    INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedulers_ws ON steward_schedulers(workspace_path);
CREATE INDEX IF NOT EXISTS idx_schedulers_due ON steward_schedulers(due_at);

-- -------------------------------------------------------
-- steward_world_state — Session 状态快照
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS steward_world_state (
  session_id          TEXT NOT NULL,
  workspace_path      TEXT NOT NULL,
  last_user_message   TEXT,
  last_user_message_at INTEGER,
  last_mission_id     TEXT,
  last_commitment_id  TEXT,
  active_mission_ids  TEXT,
  active_team_ids     TEXT,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (workspace_path, session_id)
);

-- -------------------------------------------------------
-- team_sessions — Team 快照
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_sessions (
  team_id         TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  goal            TEXT NOT NULL,
  mode            TEXT,
  status          TEXT NOT NULL DEFAULT 'created',
  leader_id       TEXT,
  member_ids      TEXT,
  blackboard      TEXT,
  mission_graph   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_sessions_ws ON team_sessions(workspace_path);
CREATE INDEX IF NOT EXISTS idx_team_sessions_session ON team_sessions(workspace_path, session_id);
CREATE INDEX IF NOT EXISTS idx_team_sessions_status ON team_sessions(status);

-- -------------------------------------------------------
-- actionlog_memories — 长期记忆条目
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS actionlog_memories (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  category        TEXT NOT NULL,
  summary         TEXT NOT NULL,
  source          TEXT,
  confidence      REAL DEFAULT 1.0,
  tags            TEXT,
  ts              INTEGER NOT NULL,
  metadata        TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_ws_cat ON actionlog_memories(workspace_path, category);
CREATE INDEX IF NOT EXISTS idx_memories_ts ON actionlog_memories(ts);

-- -------------------------------------------------------
-- actionlog_graph_nodes
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS actionlog_graph_nodes (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  label           TEXT NOT NULL,
  node_type       TEXT,
  run_id          TEXT,
  ts              INTEGER NOT NULL,
  metadata        TEXT
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_ws ON actionlog_graph_nodes(workspace_path);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON actionlog_graph_nodes(label);

-- -------------------------------------------------------
-- actionlog_graph_edges
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS actionlog_graph_edges (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_path  TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  relation        TEXT,
  run_id          TEXT,
  ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_ws ON actionlog_graph_edges(workspace_path);

-- -------------------------------------------------------
-- actionlog_session_summaries — 会话摘要
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS actionlog_session_summaries (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  session_id      TEXT,
  summary         TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  metadata        TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_summaries_ws ON actionlog_session_summaries(workspace_path);
CREATE INDEX IF NOT EXISTS idx_session_summaries_ts ON actionlog_session_summaries(ts);

-- -------------------------------------------------------
-- actionlog_events — 事件流
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS actionlog_events (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  ts              INTEGER NOT NULL,
  event_type      TEXT NOT NULL,
  session_id      TEXT,
  run_id          TEXT,
  actor           TEXT,
  summary         TEXT,
  reason          TEXT,
  files           TEXT,
  data            TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ws ON actionlog_events(workspace_path);
CREATE INDEX IF NOT EXISTS idx_events_ts ON actionlog_events(workspace_path, ts);
CREATE INDEX IF NOT EXISTS idx_events_session ON actionlog_events(workspace_path, session_id);

-- -------------------------------------------------------
-- session_items — 会话消息历史
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  workspace_path  TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  item_type       TEXT NOT NULL,
  item_data       TEXT NOT NULL,
  ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_items_session ON session_items(session_id);
CREATE INDEX IF NOT EXISTS idx_session_items_ws ON session_items(workspace_path, session_id);

-- -------------------------------------------------------
-- conversation_ledger — 对话记录（替代 .neox/conversations/*.json）
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  workspace_path  TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  turn_id         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_conversation_ledger_session ON conversation_ledger(session_id, workspace_path);

-- -------------------------------------------------------
-- interrupted_runs — 正在跑的 turn 留下面包屑
--   server crash / hot-reload / OOM 后, bootstrap 时扫这张表找 stale 的 turn
--   一条 row = 一个 in-flight turn (一个 session 同时只能有一个 in-flight turn)
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS interrupted_runs (
  session_id        TEXT PRIMARY KEY,           -- session 维度唯一
  workspace_path    TEXT NOT NULL,
  mode              TEXT NOT NULL,              -- 'agentic'
  model             TEXT NOT NULL,
  provider_id       TEXT,
  prompt            TEXT NOT NULL,              -- 触发本 turn 的原始 user prompt (诊断用)
  metadata          TEXT,                       -- JSON: { thinkingMode, attachments, runMode, ... }
  started_at        INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,           -- 每 5s 主动 UPDATE
  server_pid        INTEGER,
  server_token      TEXT,                       -- 写入时的 server authToken — resume 时比对识别真重启
  iteration         INTEGER DEFAULT 0,
  status            TEXT DEFAULT 'running',     -- 'running' | 'completed' | 'errored' | 'cancelled' | 'resumed'
  completed_at      INTEGER,
  error_message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_interrupted_runs_status ON interrupted_runs(status);
CREATE INDEX IF NOT EXISTS idx_interrupted_runs_workspace ON interrupted_runs(workspace_path);

-- -------------------------------------------------------
-- background_processes — 后台进程跨 server 持久化
--   detached 进程 (e.g. dev server) 跨 server 重启仍然活着,
--   bootstrap 时 ProcessManager 重新接管
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS background_processes (
  pid               INTEGER PRIMARY KEY,
  task              TEXT NOT NULL,
  session_id        TEXT,
  command           TEXT,
  workspace_path    TEXT NOT NULL,
  started_at        INTEGER NOT NULL,
  state             TEXT NOT NULL,              -- 'running' | 'completed' | 'failed' | 'interrupted'
  exit_code         INTEGER,
  detached          INTEGER NOT NULL DEFAULT 0, -- 1 = 进程跟 server 解耦, 重启后还活着
  last_seen_at      INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_background_processes_ws ON background_processes(workspace_path);
CREATE INDEX IF NOT EXISTS idx_background_processes_session ON background_processes(session_id);
CREATE INDEX IF NOT EXISTS idx_background_processes_state ON background_processes(state);

-- -------------------------------------------------------
-- pending_ask_user — ask_user 工具调用持久化, 跨 server 重启可恢复
--   场景: agent 调 ask_user → 等用户答案. 服务重启 → 内存 Promise 死了, 用户的
--   submit 会丢. 持久化后, 用户 submit 命中磁盘记录, 走 resume 路径: 追加
--   tool_result + chat({isResume:true}) 继续 agentLoop.
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_ask_user (
  tool_call_id TEXT PRIMARY KEY,                 -- askUserTool 生成的 unique id
  session_id   TEXT NOT NULL,
  questions    TEXT NOT NULL,                    -- JSON: AskUserQuestionInput[]
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_ask_user_session ON pending_ask_user(session_id);
`;
