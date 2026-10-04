/**
 * AgentBar - Sub-agent type definitions
 *
 * Agent 渲染已统一到 StatusLine 的 worker 行。
 * HintLine 显示 "N background tasks" pill。
 * 此文件只导出类型定义供其他组件使用。
 */

import React from 'react';

export interface SidebarAgent {
  id: string;
  role: string;
  task: string;
  status: 'running' | 'completed' | 'error';
  toolCount: number;
  tokens: number;
  elapsed: number;
  /** 工具调用记录 — 后台 agent 详情面板 (Tab→↑↓) 用 */
  toolRecords?: Array<{ name: string; args?: string; status: 'running' | 'done' | 'error' }>;
}

export interface AgentBarProps {
  agents: SidebarAgent[];
}

// No-op: agent rendering unified into StatusLine worker lines
export const AgentBar: React.FC<AgentBarProps> = () => null;
