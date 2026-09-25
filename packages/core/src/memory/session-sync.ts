/**
 * Session Sync Manager
 *
 * 负责同步 Memory (运行时) 和 Session (持久化) 之间的状态
 * 支持撤销、检查点、回滚等操作
 */

import type { Session, SessionItem, MessageItem, FileSnapshotItem, FileEditSnapshotItem } from '@neoxlabs/kernel/types/session.js';
import type { Message } from '@neoxlabs/kernel/types/index.js';
import { getTextFromContent, normalizeMessageContent } from '@neoxlabs/kernel/utils/messageUtils.js';
import { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import { SessionContext } from '@neoxlabs/platform/platform/sessionContext.js';
import { isCompactionSummaryMessage } from '@neoxlabs/kernel/utils/compression/llmSummarizer.js';
import { getTurnFileBaseline } from '../runtime/checkpoint/turnBaselineRegistry.js';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// 配置
// ============================================================================

export interface SessionSyncOptions {
  /** Session 实例 */
  session: Session;
  /** Memory 实例 */
  memory: ShortTermMemory;
  /** 系统提示词（可选，加载历史时会排除） */
  systemPrompt?: string;
}

export interface UndoResult {
  success: boolean;
  undoneCount: number;
  messages: Message[];
}

export interface RollbackResult {
  success: boolean;
  removedCount: number;
}

// ============================================================================
// SessionSyncManager 实现
// ============================================================================

export class SessionSyncManager {
  private session: Session;
  private memory: ShortTermMemory;
  private systemPrompt?: string;
  private turnCount: number = 0;
  private isSyncing: boolean = false;

  constructor(options: SessionSyncOptions) {
    this.session = options.session;
    this.memory = options.memory;
    this.systemPrompt = options.systemPrompt;
  }

  // --------------------------------------------------------------------------
  // 核心同步方法
  // --------------------------------------------------------------------------

  /**
   * 从 SessionContext 还原历史到 Memory.
   * Phase 3 Final: 不再直接读 session.getMessages() — SessionContext 是 messages 表的
   * 全 role 单源, 拿它的 cache 一致性最强 (singleton, 跨 caller 共享, 重启自动从 DB load).
   * raw 字段保留 tool_calls / tool_call_id / 数组 content, LLM 看到的上下文跟之前 1:1 一致.
   *
   * 主要 caller: 兜底 self-heal (agenticRuntime 已在 buildHostConfig 阶段 seed,
   * 这里给 compaction / undo / 异常恢复做 reload). 调 memory.clear() 是预期行为.
   */
  async loadHistory(): Promise<number> {
    const ctx = SessionContext.get(this.session.sessionId);

    this.memory.clear();
    if (this.systemPrompt) {
      this.memory.add({ role: 'system', content: this.systemPrompt });
    }

    let userCount = 0;
    for (const item of ctx.getAll()) {
      // 用本轮 systemPrompt, 不复用 DB 里那条; 压缩摘要例外 (原文已压掉, 摘要就是那段历史)
      if (item.role === 'system' && !isCompactionSummaryMessage(item)) continue;
      if (item.role === 'user') userCount++;
      if (item.raw && typeof item.raw === 'object') {
        const normalized = {
          ...item.raw,
          role: item.role,
          content: normalizeMessageContent(item.raw.content ?? item.content),
        };
        this.memory.add(normalized as Message);
      } else {
        this.memory.add({ role: item.role as Message['role'], content: item.content });
      }
    }
    this.turnCount = userCount;
    return ctx.size;
  }


  updateSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  // --------------------------------------------------------------------------
  // 撤销和回滚
  // --------------------------------------------------------------------------

  /**
   * 撤销最近 n 轮对话
   *
   * 一轮 = 用户消息 + 助手回复
   */
  async undo(turns: number = 1): Promise<UndoResult> {
    if (turns <= 0) {
      return { success: false, undoneCount: 0, messages: [] };
    }

    this.isSyncing = true;
    const undoneMessages: Message[] = [];

    try {
      for (let i = 0; i < turns; i++) {
        // 撤销助手回复
        const assistant = await this.session.popItem();
        if (!assistant) break;

        // 撤销用户消息
        const user = await this.session.popItem();
        if (!user) {
          // 如果只有助手消息，放回去
          await this.session.addItems([assistant]);
          break;
        }

        // 收集撤销的消息
        if (assistant.type === 'message') {
          undoneMessages.unshift((assistant as MessageItem).data);
        }
        if (user.type === 'message') {
          undoneMessages.unshift((user as MessageItem).data);
        }
      }

      // 重新加载 Memory
      await this.loadHistory();

      return {
        success: undoneMessages.length > 0,
        undoneCount: Math.floor(undoneMessages.length / 2),
        messages: undoneMessages
      };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 撤销到指定消息（通过内容匹配）
   */
  async undoUntil(contentPrefix: string): Promise<UndoResult> {
    this.isSyncing = true;
    const undoneMessages: Message[] = [];

    try {
      while (true) {
        const item = await this.session.popItem();
        if (!item) break;

        if (item.type === 'message') {
          const msg = (item as MessageItem).data;
          undoneMessages.unshift(msg);

          // 检查是否到达目标
          const contentText = getTextFromContent(msg.content);
          if (contentText?.startsWith(contentPrefix)) {
            // 把这条放回去
            await this.session.addItems([item]);
            undoneMessages.shift();
            break;
          }
        }
      }

      await this.loadHistory();

      return {
        success: undoneMessages.length > 0,
        undoneCount: Math.ceil(undoneMessages.length / 2),
        messages: undoneMessages
      };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 创建检查点
   */
  async createCheckpoint(name?: string): Promise<string> {
    const description = `Turn ${this.turnCount}, ${new Date().toLocaleString()}`;
    /* 把本轮的 Shadow Git 基线一起记进去 —— 没有它, 回滚到这个点只会裁对话、不动文件。
     * 见 runtime/checkpoint/turnBaselineRegistry.ts 的注释。 */
    const fileCheckpointId = getTurnFileBaseline(this.session.sessionId);
    return await this.session.createCheckpoint(name, description, fileCheckpointId);
  }

  /**
   * 回滚到检查点
   */
  async rollback(checkpointId: string): Promise<RollbackResult> {
    this.isSyncing = true;

    try {
      // 首先获取将要被删除的 items（用于文件回滚）
      const allItems = await this.session.getItems();
      const checkpointIndex = allItems.findIndex(
        item => item.type === 'checkpoint' && (item as any).data.id === checkpointId
      );

      if (checkpointIndex === -1) {
        throw new Error(`Checkpoint not found: ${checkpointId}`);
      }

      // 获取检查点之后的所有 items
      const itemsToRemove = allItems.slice(checkpointIndex + 1);

      // 执行 session 回滚
      const removedCount = await this.session.rollbackToCheckpoint(checkpointId);

      // 回滚文件操作
      await this.rollbackFileOperations(itemsToRemove);

      // 重新加载 Memory
      await this.loadHistory();

      return {
        success: true,
        removedCount
      };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 回滚文件操作
   */
  private async rollbackFileOperations(removedItems: SessionItem[]): Promise<void> {
    // 收集所有文件快照和编辑快照
    const fileSnapshots: FileSnapshotItem[] = [];
    const editSnapshots: FileEditSnapshotItem[] = [];

    for (const item of removedItems) {
      if (item.type === 'file_snapshot') {
        fileSnapshots.push(item as FileSnapshotItem);
      } else if (item.type === 'file_edit_snapshot') {
        editSnapshots.push(item as FileEditSnapshotItem);
      }
    }

    // 按文件路径分组，处理完整文件快照
    const fileMap = new Map<string, FileSnapshotItem>();
    for (const snapshot of fileSnapshots) {
      const filePath = snapshot.data.filePath;
      if (!fileMap.has(filePath)) {
        fileMap.set(filePath, snapshot);
      }
    }

    // 按文件路径分组编辑快照，收集所有编辑
    const editMap = new Map<string, FileEditSnapshotItem[]>();
    for (const snapshot of editSnapshots) {
      const filePath = snapshot.data.filePath;
      if (!editMap.has(filePath)) {
        editMap.set(filePath, []);
      }
      editMap.get(filePath)!.push(snapshot);
    }

    // 处理完整文件快照（优先级高，直接恢复）
    for (const [filePath, snapshot] of fileMap) {
      try {
        const absolutePath = path.resolve(filePath);

        if (snapshot.data.originalContent === null) {
          // 文件原本不存在，删除它
          if (fs.existsSync(absolutePath)) {
            await fs.promises.unlink(absolutePath);
            console.log(`  ↺ Deleted file: ${filePath}`);
          }
        } else {
          // 恢复文件内容
          const dir = path.dirname(absolutePath);
          await fs.promises.mkdir(dir, { recursive: true });
          await fs.promises.writeFile(absolutePath, snapshot.data.originalContent, 'utf-8');
          console.log(`  ↺ Restored file: ${filePath}`);
        }

        // 如果已经完整恢复，移除编辑快照
        editMap.delete(filePath);
      } catch (error: any) {
        console.error(`  ⚠ Failed to restore ${filePath}: ${error.message}`);
      }
    }

    // 处理编辑快照（倒序应用反向操作）
    for (const [filePath, edits] of editMap) {
      try {
        const absolutePath = path.resolve(filePath);

        if (!fs.existsSync(absolutePath)) {
          console.error(`  ⚠ File not found for rollback: ${filePath}`);
          continue;
        }

        let content = await fs.promises.readFile(absolutePath, 'utf-8');

        // 倒序应用编辑（从最后一次编辑开始撤销）
        for (let i = edits.length - 1; i >= 0; i--) {
          const edit = edits[i];

          // 反向替换：new_string → old_string
          if (edit.data.replaceAll) {
            content = content.split(edit.data.newString).join(edit.data.oldString);
          } else {
            // 只替换最后一次出现（因为我们是倒序回滚）
            const lastIndex = content.lastIndexOf(edit.data.newString);
            if (lastIndex !== -1) {
              content = content.substring(0, lastIndex) +
                        edit.data.oldString +
                        content.substring(lastIndex + edit.data.newString.length);
            }
          }
        }

        await fs.promises.writeFile(absolutePath, content, 'utf-8');
        console.log(`  ↺ Reverted ${edits.length} edit(s) in: ${filePath}`);
      } catch (error: any) {
        console.error(`  ⚠ Failed to rollback edits in ${filePath}: ${error.message}`);
      }
    }
  }

  /**
   * 获取所有检查点
   */
  async getCheckpoints(): Promise<Array<{ id: string; name?: string; timestamp: number }>> {
    return await this.session.getCheckpoints();
  }

  // --------------------------------------------------------------------------
  // 状态查询
  // --------------------------------------------------------------------------

  /**
   * 获取当前轮次数
   */
  getTurnCount(): number {
    return this.turnCount;
  }

  /**
   * 获取 Session ID
   */
  getSessionId(): string {
    return this.session.sessionId;
  }

  /**
   * 获取 Session 实例
   */
  getSession(): Session {
    return this.session;
  }

  /**
   * 获取 Memory 实例
   */
  getMemory(): ShortTermMemory {
    return this.memory;
  }

  /**
   * 获取会话信息
   */
  async getSessionInfo(): Promise<{
    sessionId: string;
    turnCount: number;
    messageCount: number;
    checkpointCount: number;
    meta: any;
  }> {
    const meta = await this.session.getMeta();
    const itemCount = await this.session.getItemCount();
    const checkpoints = await this.session.getCheckpoints();

    return {
      sessionId: this.session.sessionId,
      turnCount: this.turnCount,
      messageCount: (await this.session.getMessages()).length,
      checkpointCount: checkpoints.length,
      meta
    };
  }

  /**
   * 设置系统提示词
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /**
   * 清空会话
   */
  async clearSession(): Promise<void> {
    await this.session.clearSession();
    this.memory.clear();
    this.turnCount = 0;

    // 重新添加系统提示词
    if (this.systemPrompt) {
      this.memory.add({ role: 'system', content: this.systemPrompt });
    }
  }
}
