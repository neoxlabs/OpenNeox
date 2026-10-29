/**
 * Debug Service - 统一的调试服务
 * 管理断点、调试状态，桥接 Monaco Editor 和 DAP
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs/promises';

// 断点类型
export interface Breakpoint {
  id: string;
  file: string;           // 绝对路径
  line: number;
  column?: number;
  condition?: string;     // 条件断点
  hitCondition?: string;  // 命中次数条件
  logMessage?: string;    // 日志断点
  enabled: boolean;
  verified: boolean;      // 是否已被调试器验证
  source: 'user' | 'llm'; // 来源：用户手动设置或 LLM 设置
}

// 变量信息
export interface Variable {
  name: string;
  value: string;
  type: string;
  variablesReference: number; // 用于展开复杂对象
  children?: Variable[];
}

// 调用栈帧
export interface StackFrame {
  id: number;
  name: string;
  file: string;
  line: number;
  column: number;
  source?: string;
}

// 调试会话状态
export interface DebugSessionState {
  id: string;
  status: 'idle' | 'running' | 'paused' | 'stopped';
  currentFile?: string;
  currentLine?: number;
  stackFrames: StackFrame[];
  variables: Variable[];
  threads: { id: number; name: string }[];
  currentThreadId?: number;
}

// 调试事件类型
export type DebugEventType = 
  | 'breakpoint-added'
  | 'breakpoint-removed'
  | 'breakpoint-changed'
  | 'breakpoint-hit'
  | 'session-started'
  | 'session-stopped'
  | 'paused'
  | 'continued'
  | 'variables-updated'
  | 'stack-updated'
  | 'output';

export interface DebugEvent {
  type: DebugEventType;
  data: any;
  timestamp: number;
}

export class DebugService extends EventEmitter {
  private breakpoints: Map<string, Breakpoint[]> = new Map(); // file -> breakpoints
  private sessions: Map<string, DebugSessionState> = new Map();
  private breakpointCounter = 0;

  constructor() {
    super();
  }

  // ==================== 断点管理 ====================

  /**
   * 添加断点
   */
  addBreakpoint(
    file: string,
    line: number,
    options: {
      condition?: string;
      hitCondition?: string;
      logMessage?: string;
      source?: 'user' | 'llm';
    } = {}
  ): Breakpoint {
    const absolutePath = path.isAbsolute(file) ? file : path.resolve(file);
    const id = `bp-${++this.breakpointCounter}`;

    const breakpoint: Breakpoint = {
      id,
      file: absolutePath,
      line,
      condition: options.condition,
      hitCondition: options.hitCondition,
      logMessage: options.logMessage,
      enabled: true,
      verified: false,
      source: options.source || 'user',
    };

    const fileBreakpoints = this.breakpoints.get(absolutePath) || [];
    // 检查是否已存在相同行的断点
    const existingIdx = fileBreakpoints.findIndex(bp => bp.line === line);
    if (existingIdx !== -1) {
      // 更新已有断点
      fileBreakpoints[existingIdx] = { ...fileBreakpoints[existingIdx], ...breakpoint };
    } else {
      fileBreakpoints.push(breakpoint);
    }
    this.breakpoints.set(absolutePath, fileBreakpoints);

    this.emitEvent('breakpoint-added', breakpoint);
    // console.log(`[DebugService] Added breakpoint: ${absolutePath}:${line}`);
    return breakpoint;
  }

  /**
   * 移除断点
   */
  removeBreakpoint(file: string, line: number): boolean {
    const absolutePath = path.isAbsolute(file) ? file : path.resolve(file);
    const fileBreakpoints = this.breakpoints.get(absolutePath);
    if (!fileBreakpoints) return false;

    const idx = fileBreakpoints.findIndex(bp => bp.line === line);
    if (idx === -1) return false;

    const removed = fileBreakpoints.splice(idx, 1)[0];
    if (fileBreakpoints.length === 0) {
      this.breakpoints.delete(absolutePath);
    }

    this.emitEvent('breakpoint-removed', removed);
    // console.log(`[DebugService] Removed breakpoint: ${absolutePath}:${line}`);
    return true;
  }

  /**
   * 移除断点（通过 ID）
   */
  removeBreakpointById(id: string): boolean {
    for (const [file, bps] of this.breakpoints.entries()) {
      const idx = bps.findIndex(bp => bp.id === id);
      if (idx !== -1) {
        const removed = bps.splice(idx, 1)[0];
        if (bps.length === 0) {
          this.breakpoints.delete(file);
        }
        this.emitEvent('breakpoint-removed', removed);
        return true;
      }
    }
    return false;
  }

  /**
   * 切换断点启用状态
   */
  toggleBreakpoint(file: string, line: number): Breakpoint | null {
    const absolutePath = path.isAbsolute(file) ? file : path.resolve(file);
    const fileBreakpoints = this.breakpoints.get(absolutePath);
    if (!fileBreakpoints) return null;

    const bp = fileBreakpoints.find(b => b.line === line);
    if (!bp) return null;

    bp.enabled = !bp.enabled;
    this.emitEvent('breakpoint-changed', bp);
    return bp;
  }

  /**
   * 获取文件的所有断点
   */
  getBreakpointsForFile(file: string): Breakpoint[] {
    const absolutePath = path.isAbsolute(file) ? file : path.resolve(file);
    return this.breakpoints.get(absolutePath) || [];
  }

  /**
   * 获取所有断点
   */
  getAllBreakpoints(): Breakpoint[] {
    const all: Breakpoint[] = [];
    for (const bps of this.breakpoints.values()) {
      all.push(...bps);
    }
    return all;
  }

  /**
   * 清除所有断点
   */
  clearAllBreakpoints(): void {
    const all = this.getAllBreakpoints();
    this.breakpoints.clear();
    for (const bp of all) {
      this.emitEvent('breakpoint-removed', bp);
    }
  }

  /**
   * 清除特定来源的断点
   */
  clearBreakpointsBySource(source: 'user' | 'llm'): void {
    for (const [file, bps] of this.breakpoints.entries()) {
      const remaining = bps.filter(bp => bp.source !== source);
      const removed = bps.filter(bp => bp.source === source);
      
      if (remaining.length === 0) {
        this.breakpoints.delete(file);
      } else {
        this.breakpoints.set(file, remaining);
      }
      
      for (const bp of removed) {
        this.emitEvent('breakpoint-removed', bp);
      }
    }
  }

  // ==================== 调试会话管理 ====================

  /**
   * 创建调试会话
   */
  createSession(id: string): DebugSessionState {
    const session: DebugSessionState = {
      id,
      status: 'idle',
      stackFrames: [],
      variables: [],
      threads: [],
    };
    this.sessions.set(id, session);
    this.emitEvent('session-started', { sessionId: id });
    return session;
  }

  /**
   * 更新会话状态
   */
  updateSession(id: string, updates: Partial<DebugSessionState>): void {
    const session = this.sessions.get(id);
    if (!session) return;

    Object.assign(session, updates);

    if (updates.status === 'paused') {
      this.emitEvent('paused', {
        sessionId: id,
        file: session.currentFile,
        line: session.currentLine,
        stackFrames: session.stackFrames,
      });
    } else if (updates.status === 'running') {
      this.emitEvent('continued', { sessionId: id });
    }

    if (updates.variables) {
      this.emitEvent('variables-updated', {
        sessionId: id,
        variables: updates.variables,
      });
    }

    if (updates.stackFrames) {
      this.emitEvent('stack-updated', {
        sessionId: id,
        stackFrames: updates.stackFrames,
      });
    }
  }

  /**
   * 结束调试会话
   */
  endSession(id: string): void {
    this.sessions.delete(id);
    this.emitEvent('session-stopped', { sessionId: id });
  }

  /**
   * 获取会话状态
   */
  getSession(id: string): DebugSessionState | undefined {
    return this.sessions.get(id);
  }

  /**
   * 获取所有会话
   */
  getAllSessions(): DebugSessionState[] {
    return Array.from(this.sessions.values());
  }

  // ==================== 断点命中处理 ====================

  /**
   * 处理断点命中（由 DAP 客户端调用）
   */
  handleBreakpointHit(sessionId: string, file: string, line: number): void {
    const absolutePath = path.isAbsolute(file) ? file : path.resolve(file);
    const bp = this.getBreakpointsForFile(absolutePath).find(b => b.line === line);
    
    this.emitEvent('breakpoint-hit', {
      sessionId,
      breakpoint: bp,
      file: absolutePath,
      line,
    });

    // 更新会话状态
    this.updateSession(sessionId, {
      status: 'paused',
      currentFile: absolutePath,
      currentLine: line,
    });
  }

  // ==================== 辅助方法 ====================

  private emitEvent(type: DebugEventType, data: any): void {
    const event: DebugEvent = {
      type,
      data,
      timestamp: Date.now(),
    };
    this.emit('debug-event', event);
    this.emit(type, data);
  }

  /**
   * 序列化断点（用于持久化）
   */
  serializeBreakpoints(): string {
    const data: Record<string, Breakpoint[]> = {};
    for (const [file, bps] of this.breakpoints.entries()) {
      data[file] = bps;
    }
    return JSON.stringify(data, null, 2);
  }

  /**
   * 反序列化断点（从持久化恢复）
   */
  deserializeBreakpoints(json: string): void {
    try {
      const data = JSON.parse(json) as Record<string, Breakpoint[]>;
      for (const [file, bps] of Object.entries(data)) {
        this.breakpoints.set(file, bps);
        for (const bp of bps) {
          this.emitEvent('breakpoint-added', bp);
        }
      }
    } catch (error) {
      console.error('[DebugService] Failed to deserialize breakpoints:', error);
    }
  }
}

// 单例
let debugServiceInstance: DebugService | null = null;

export function getDebugService(): DebugService {
  if (!debugServiceInstance) {
    debugServiceInstance = new DebugService();
  }
  return debugServiceInstance;
}
