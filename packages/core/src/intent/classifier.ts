
import type {
  TaskComplexity,
  IntentResult,
  ExecutionStrategy,
  IntentContext,
} from './types.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { LLMProvider } from '@neoxlabs/kernel/types/index.js';

/**
 * 意图识别分类器（使用 LLM 进行智能分类）
 */
export class IntentClassifier {
  private llmProvider?: LLMProvider;
  private model?: string;

  // 阈值配置（用于映射到分数）
  private readonly SIMPLE_THRESHOLD = 40;   // 0-39: Simple
  private readonly TODO_THRESHOLD = 80;     // 40-79: Todo
  // >= 80: Plan

  /**
   * 设置 LLM Provider（用于智能分类）
   */
  setLLMProvider(provider: LLMProvider, model: string): void {
    this.llmProvider = provider;
    this.model = model;
  }

  /**
   * 分析用户意图（使用 LLM 快速分类，用于生成合适的 System Prompt）
   */
  async analyze(context: IntentContext): Promise<IntentResult> {
    let complexity: TaskComplexity;
    let reasons: string[] = [];

    if (this.llmProvider && this.model) {
      try {
        complexity = await this.llmClassify(context.userInput);
        reasons = ['基于 LLM 智能判断'];
        cliLogger.info('INTENT', `Task classified as ${complexity.toUpperCase()} (LLM)`, {
          method: 'llm-based',
          task: context.userInput.substring(0, 50),
        });
      } catch (error: any) {
        // LLM 分类失败，降级到启发式分类
        cliLogger.warn('INTENT', 'LLM classification failed, fallback to heuristic', {
          error: error.message,
        });
        complexity = this.heuristicClassify(context.userInput);
        reasons = ['LLM 分类失败，使用启发式分类'];
      }
    } else {
      // 没有 LLM Provider，使用启发式分类
      complexity = this.heuristicClassify(context.userInput);
      reasons = ['基于启发式分类（未配置 LLM）'];
      cliLogger.info('INTENT', `Task classified as ${complexity.toUpperCase()} (Heuristic)`, {
        method: 'heuristic',
      });
    }

    const score = this.complexityToScore(complexity);
    const strategy = this.generateStrategy(complexity, score);

    return {
      complexity,
      score,
      maxScore: 150,
      reasons,
      strategy,
      systemPrompt: this.generateSystemPromptSimple(complexity),
      metadata: {
        riskLevel: 'low',
      },
    };
  }

  private async llmClassify(userInput: string): Promise<TaskComplexity> {
    if (!this.llmProvider || !this.model) {
      throw new Error('LLM Provider not configured');
    }

    // 构建分类 prompt
    const classificationPrompt = `你是一个任务复杂度分类器。请分析以下用户输入，判断任务的复杂度等级。

任务复杂度定义：
- **simple（简单）**：1-2 个步骤即可完成，如查询信息、修复拼写错误、读取文件等
- **medium（中等）**：3-7 个步骤，需要一定规划，如实现一个功能、重构一个模块、添加 API 等
- **complex（复杂）**：10+ 个步骤，需要详细规划，如实现完整项目、迁移架构、从零搭建系统等

用户输入：
${userInput}

请直接输出复杂度等级（只输出 simple、medium 或 complex，不要有其他内容）：`;

    try {
      // 调用 LLM chat 方法（使用简短的 temperature 和 max_tokens）
      const response = await this.llmProvider.chat(
        [{ role: 'user' as const, content: classificationPrompt }],
        {
          model: this.model,
          temperature: 0.1, // 低温度确保稳定输出
        }
      );

      const result = (response.choices[0]?.message?.content || '').trim().toLowerCase();

      // 解析结果
      if (result.includes('simple')) return 'simple' as TaskComplexity;
      if (result.includes('medium')) return 'medium' as TaskComplexity;
      if (result.includes('complex')) return 'complex' as TaskComplexity;

      // 无法解析，默认 medium
      cliLogger.warn('INTENT', 'LLM returned unexpected result, defaulting to medium', {
        result,
      });
      return 'medium' as TaskComplexity;
    } catch (error: any) {
      throw new Error(`LLM classification failed: ${error.message}`);
    }
  }

  private heuristicClassify(userInput: string): TaskComplexity {
    const lower = userInput.toLowerCase();

    // 复杂任务关键词
    const complexKeywords = [
      '规划', '计划', '设计方案', 'plan', 'design',
      '重构整个', '迁移', '架构', 'refactor all', 'migrate',
      '实现完整', '从零开始', '搭建', '构建',
      '大项目', '项目', 'project',
    ];
    if (complexKeywords.some(kw => lower.includes(kw))) {
      return 'complex' as TaskComplexity;
    }

    // 中等任务关键词
    const mediumKeywords = [
      '重构', '添加功能', '实现', '开发',
      'refactor', 'implement', 'add feature', 'develop',
      '修改', '优化', '改进', 'modify', 'optimize', 'improve',
      '集成', 'integrate',
    ];
    if (mediumKeywords.some(kw => lower.includes(kw))) {
      return 'medium' as TaskComplexity;
    }

    // 简单任务关键词
    const simpleKeywords = [
      '修复', '添加注释', '改名', 'fix typo', 'add comment',
      '查找', '搜索', '读取', 'find', 'search', 'read',
      '显示', '查看', 'show', 'view',
    ];
    if (simpleKeywords.some(kw => lower.includes(kw))) {
      return 'simple' as TaskComplexity;
    }

    // 长度判断
    if (userInput.length < 15) return 'simple' as TaskComplexity;
    if (userInput.length < 80) return 'medium' as TaskComplexity;
    return 'complex' as TaskComplexity;
  }

  /**
   * 将复杂度转换为分数
   */
  private complexityToScore(complexity: TaskComplexity): number {
    const baseScores = {
      simple: 20,
      medium: 60,
      complex: 100,
    };
    return baseScores[complexity] || 20;
  }

  /**
   * 生成执行策略
   */
  private generateStrategy(complexity: TaskComplexity, score: number): ExecutionStrategy {
    switch (complexity) {
      case 'simple':
        return {
          type: 'direct',
          requiresApproval: false,
          renderer: {
            cli: 'stream',
            ui: 'message',
          },
        };

      case 'medium':
        return {
          type: 'todo',
          tools: ['update_todolist'],
          requiresApproval: false,
          renderer: {
            cli: 'checkbox',
            ui: 'todo-card',
          },
        };

      case 'complex':
      default:
        return {
          type: 'plan',
          tools: ['update_plan', 'verify_step'],
          requiresApproval: true,
          renderer: {
            cli: 'progress',
            ui: 'plan-card',
          },
        };
    }
  }

  /**
   * 生成简化的 System Prompt（引导 LLM 自己判断何时使用工具）
   */
  private generateSystemPromptSimple(complexity: TaskComplexity): string {
    // LLM 自己判断是否需要 TodoList 或 Plan
    return `## 任务规划工具使用指南

你有以下工具可用于规划和追踪任务进度：

### 1. update_todolist（中等复杂度任务）
**何时使用**：
- 任务需要 3-7 个明确步骤
- 步骤顺序清晰，依赖关系简单
- 无需复杂验证，但需要追踪进度

**示例场景**：
- "实现用户登录功能"
- "重构某个模块"
- "添加API接口"

**使用方式**：
\`\`\`json
{
  "items": [
    {
      "content": "实现登录API",
      "activeForm": "正在实现登录API",
      "status": "pending"
    },
    {
      "content": "添加前端登录表单",
      "activeForm": "正在添加前端登录表单",
      "status": "pending"
    }
  ]
}
\`\`\`

**注意事项**：
- 同时只能有一个 \`in_progress\` 项
- 完成后立即标记为 \`completed\`
- 保持 3-7 个步骤，不要过多

### 2. update_plan（复杂长期任务）
**何时使用**：
- 任务需要 10+ 步骤
- 步骤间有复杂依赖关系
- 高风险操作，需要验证和重试机制

**示例场景**：
- "迁移整个认证系统"
- "重构项目架构"
- "实现完整的支付流程"

### 3. 直接执行（简单任务）
**何时使用**：
- 单一操作，1-2 个工具调用即可完成
- 无需规划和追踪进度

**示例场景**：
- "读取文件内容"
- "查找函数定义"
- "修复拼写错误"

---

**重要**：你自己判断任务复杂度，选择最合适的方式：
- 简单任务 → 直接执行
- 中等任务 → 使用 \`update_todolist\`
- 复杂任务 → 使用 \`update_plan\`
`;
  }
}

/**
 * 创建意图分类器
 */
export function createIntentClassifier(): IntentClassifier {
  return new IntentClassifier();
}

/**
 * 快速分析意图 (便捷函数)
 */
export async function analyzeIntent(
  userInput: string,
  options?: {
    workspacePath?: string;
    projectInfo?: any;
  }
): Promise<IntentResult> {
  const classifier = createIntentClassifier();
  return classifier.analyze({
    userInput,
    workspacePath: options?.workspacePath,
    projectInfo: options?.projectInfo,
  });
}
