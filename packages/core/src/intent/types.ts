/**
 * 意图识别类型定义
 */

/**
 * 任务复杂度层级
 */
export enum TaskComplexity {
  Simple = 'simple',    // 简单任务: 直接执行
  Medium = 'medium',    // 中等任务: TodoList
  Complex = 'complex',  // 复杂任务: Plan Mode
}

/**
 * 意图识别结果
 */
export interface IntentResult {
  /** 任务复杂度层级 */
  complexity: TaskComplexity;

  /** 评分结果 */
  score: number;

  /** 最大分数 */
  maxScore: number;

  /** 触发原因 */
  reasons: string[];

  /** 推荐的执行策略 */
  strategy: ExecutionStrategy;

  /** System Prompt 增强 */
  systemPrompt?: string;

  /** 元数据 */
  metadata: {
    estimatedDuration?: number;  // 预估时长 (分钟)
    estimatedSteps?: number;     // 预估步骤数
    riskLevel?: 'low' | 'medium' | 'high';
  };
}

/**
 * 执行策略
 */
export interface ExecutionStrategy {
  /** 策略类型 */
  type: 'direct' | 'todo' | 'plan';

  /** 需要的工具 */
  tools?: string[];

  /** 是否需要用户确认 */
  requiresApproval: boolean;

  /** 渲染器配置 */
  renderer: {
    cli: 'stream' | 'checkbox' | 'progress';
    ui: 'message' | 'todo-card' | 'plan-card';
  };
}

/**
 * 意图分析上下文
 */
export interface IntentContext {
  /** 用户输入 */
  userInput: string;

  /** 工作区路径 */
  workspacePath?: string;

  /** 会话历史 */
  conversationHistory?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;

  /** 项目信息 */
  projectInfo?: {
    type?: string;
    fileCount?: number;
    language?: string;
  };
}
