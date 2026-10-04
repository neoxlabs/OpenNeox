/**
 * 工具批量检测器
 * Phase 3: 批量检测和合并
 *
 * 检测连续的相同工具调用并合并显示
 */

export interface BatchDecision {
  type: 'single' | 'batch';
  merge: boolean;              // 是否应该合并到现有批量
  batchId?: string;            // 批量操作的 ID（用于更新）
  shouldCreateBatch?: boolean; // 是否应该创建新批量
}

export interface PendingToolCall {
  toolId: string;
  toolName: string;
  targetPath: string;
  startTime: number;
  args: Record<string, any>;
}

export interface BatchInfo {
  batchId: string;
  toolName: string;
  targets: string[];
  startTime: number;
  lastCallTime: number;
  completed: number;
  total: number;
}

/**
 * 批量检测器
 *
 * 检测逻辑：
 * 1. 在时间窗口内（默认 200ms）
 * 2. 相同的工具名称
 * 3. 工具支持批量处理
 * 4. 目标路径不同（避免重复操作同一文件）
 */
export class ToolBatchDetector {
  // 批量时间窗口（毫秒）
  private batchTimeWindow: number;
  
  // 当前正在进行的批量操作
  private activeBatches: Map<string, BatchInfo> = new Map();
  
  // 待处理的工具调用（用于检测批量）
  private pendingCalls: Map<string, PendingToolCall[]> = new Map();
  
  // 支持批量处理的工具列表
  private batchableTools = new Set([
    'readfile',
    // write_file / create_file 不参与 batch — 它们有独立的 file_stream 预览 + WriteFileCard,
    // batch 检测会额外创建 "Starting batch operation..." 空壳卡片导致多渲染.
    'list_directory',
    'LS',
    'Glob',
    'find_files',
    'read_multiple_files',
  ]);

  constructor(batchTimeWindow: number = 200) {
    this.batchTimeWindow = batchTimeWindow;
  }

  /**
   * 检测工具调用是否应该批量处理
   */
  detectBatch(
    toolId: string,
    toolName: string,
    targetPath: string,
    args: Record<string, any>,
    timestamp: number
  ): BatchDecision {
    // 1. 检查工具是否支持批量处理
    if (!this.isBatchable(toolName)) {
      return { type: 'single', merge: false };
    }

    // 2. 检查是否有待处理的相同工具调用
    const pending = this.pendingCalls.get(toolName) || [];
    
    if (pending.length === 0) {
      // 第一个调用，加入待处理列表
      this.pendingCalls.set(toolName, [{
        toolId,
        toolName,
        targetPath,
        startTime: timestamp,
        args,
      }]);
      return { type: 'single', merge: false };
    }

    // 3. 检查最近的调用是否在时间窗口内
    const lastCall = pending[pending.length - 1];
    const timeDiff = timestamp - lastCall.startTime;

    if (timeDiff > this.batchTimeWindow) {
      // 超出时间窗口，清空待处理列表，重新开始
      this.pendingCalls.set(toolName, [{
        toolId,
        toolName,
        targetPath,
        startTime: timestamp,
        args,
      }]);
      return { type: 'single', merge: false };
    }

    // 4. 检查目标路径是否重复
    const isDuplicate = pending.some(p => p.targetPath === targetPath);
    if (isDuplicate) {
      // 相同目标，不合并（可能是重试或错误）
      return { type: 'single', merge: false };
    }

    // 5. 在时间窗口内且目标不同，应该批量处理
    if (pending.length === 1) {
      // 这是第二个调用，创建新批量
      const batchId = this.createBatch(lastCall, toolId, targetPath, timestamp);
      pending.push({ toolId, toolName, targetPath, startTime: timestamp, args });
      return {
        type: 'batch',
        merge: false,
        batchId,
        shouldCreateBatch: true,
      };
    } else {
      // 已经有批量，合并到现有批量
      const batchId = this.findActiveBatch(toolName);
      if (batchId) {
        pending.push({ toolId, toolName, targetPath, startTime: timestamp, args });
        this.updateBatch(batchId, targetPath, timestamp);
        return {
          type: 'batch',
          merge: true,
          batchId,
        };
      } else {
        // 批量已结束，开始新的单个调用
        this.pendingCalls.set(toolName, [{
          toolId,
          toolName,
          targetPath,
          startTime: timestamp,
          args,
        }]);
        return { type: 'single', merge: false };
      }
    }
  }

  /**
   * 记录工具完成
   */
  recordCompletion(toolName: string, targetPath: string): void {
    const batchId = this.findActiveBatch(toolName);
    if (batchId) {
      const batch = this.activeBatches.get(batchId);
      if (batch) {
        batch.completed++;
        
        // 检查批量是否全部完成
        if (batch.completed >= batch.total) {
          this.completeBatch(batchId);
        }
      }
    }
  }

  /**
   * 获取批量信息
   */
  getBatchInfo(batchId: string): BatchInfo | undefined {
    return this.activeBatches.get(batchId);
  }

  /**
   * 判断工具是否可批量处理
   */
  isBatchable(toolName: string): boolean {
    return this.batchableTools.has(toolName);
  }

  /**
   * 创建新批量
   */
  private createBatch(
    firstCall: PendingToolCall,
    secondToolId: string,
    secondTargetPath: string,
    timestamp: number
  ): string {
    const batchId = `batch-${firstCall.toolName}-${timestamp}`;
    
    this.activeBatches.set(batchId, {
      batchId,
      toolName: firstCall.toolName,
      targets: [firstCall.targetPath, secondTargetPath],
      startTime: firstCall.startTime,
      lastCallTime: timestamp,
      completed: 0,
      total: 2,
    });

    return batchId;
  }

  /**
   * 更新批量信息
   */
  private updateBatch(batchId: string, targetPath: string, timestamp: number): void {
    const batch = this.activeBatches.get(batchId);
    if (batch) {
      batch.targets.push(targetPath);
      batch.total++;
      batch.lastCallTime = timestamp;
    }
  }

  /**
   * 查找活跃的批量操作
   */
  private findActiveBatch(toolName: string): string | undefined {
    for (const [batchId, batch] of this.activeBatches.entries()) {
      if (batch.toolName === toolName) {
        return batchId;
      }
    }
    return undefined;
  }

  /**
   * 完成批量操作
   */
  private completeBatch(batchId: string): void {
    this.activeBatches.delete(batchId);
    
    // 清理对应的待处理调用列表
    const batch = this.activeBatches.get(batchId);
    if (batch) {
      this.pendingCalls.delete(batch.toolName);
    }
  }

  /**
   * 清理超时的批量操作
   * 应该定期调用（如每秒一次）
   */
  cleanupExpiredBatches(currentTime: number): void {
    const timeout = this.batchTimeWindow * 5; // 超时时间是时间窗口的5倍
    
    // 清理超时批量
    const expiredBatches: string[] = [];
    this.activeBatches.forEach((batch, batchId) => {
      if (currentTime - batch.lastCallTime > timeout) {
        expiredBatches.push(batchId);
      }
    });
    expiredBatches.forEach(batchId => this.completeBatch(batchId));

    // 清理待处理列表
    const expiredTools: string[] = [];
    this.pendingCalls.forEach((pending, toolName) => {
      if (pending.length > 0) {
        const lastCall = pending[pending.length - 1];
        if (currentTime - lastCall.startTime > timeout) {
          expiredTools.push(toolName);
        }
      }
    });
    expiredTools.forEach(toolName => this.pendingCalls.delete(toolName));
  }

  /**
   * 重置检测器状态
   */
  reset(): void {
    this.activeBatches.clear();
    this.pendingCalls.clear();
  }

  /**
   * 获取统计信息（用于调试）
   */
  getStats(): {
    activeBatches: number;
    pendingCalls: number;
    batches: Array<{ batchId: string; toolName: string; total: number; completed: number }>;
  } {
    const batches: Array<{ batchId: string; toolName: string; total: number; completed: number }> = [];
    
    this.activeBatches.forEach((batch, batchId) => {
      batches.push({
        batchId,
        toolName: batch.toolName,
        total: batch.total,
        completed: batch.completed,
      });
    });

    return {
      activeBatches: this.activeBatches.size,
      pendingCalls: this.pendingCalls.size,
      batches,
    };
  }
}

/**
 * 工具调用摘要生成器
 * 用于生成批量操作的摘要信息
 */
export class BatchSummaryGenerator {
  /**
   * 生成批量调用的描述
   */
  static generateBatchDescription(toolName: string, targetCount: number): string {
    switch (toolName) {
      case 'readfile':
        return `Reading ${targetCount} files`;
      
      case 'write_file':
      case 'create_file':
        return `Creating ${targetCount} files`;
      
      case 'list_directory':
      case 'LS':
        return `Listing ${targetCount} directories`;
      
      case 'Glob':
      case 'find_files':
        return `Finding files in ${targetCount} locations`;
      
      default:
        return `Processing ${targetCount} items`;
    }
  }

  /**
   * 生成批量结果摘要
   */
  static generateBatchResultSummary(
    toolName: string,
    targetCount: number,
    totalChars: number,
    duration?: number
  ): string {
    let summary = `✅ Completed ${targetCount} items`;
    
    if (totalChars > 0) {
      summary += `, ${this.formatSize(totalChars)}`;
    }
    
    if (duration) {
      summary += ` in ${this.formatDuration(duration)}`;
    }
    
    return summary;
  }

  /**
   * 格式化大小
   */
  private static formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} chars`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * 格式化时长
   */
  private static formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  }
}
