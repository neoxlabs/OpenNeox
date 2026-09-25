import type {
  OrchestratorConfig,
  AnalyzedTask,
  TaskResult,
  OrchestratedResponse,
  TaskRoutingRule,
  OrchestrationMode,
} from '@neoxlabs/platform/utils/config.js';
import type { Message, LLMProvider } from './taskAnalyzer.js';
import { TaskAnalyzer } from './taskAnalyzer.js';
import { ModelCapabilityManager } from './modelCapabilities.js';
import { SharedContextManager } from './sharedContextManager.js';
import { getModelPricing, calculateRequestCost } from '@neoxlabs/platform/platform/modelPricingTable.js';

/**
 * 任务分配
 */
interface TaskAssignment {
  task: AnalyzedTask;
  model: string;
  taskIndex: number;
}

/**
 * 执行阶段
 */
interface ExecutionStage {
  mode: 'parallel' | 'sequential';
  tasks: TaskAssignment[];
}

/**
 * 执行图
 */
interface ExecutionGraph {
  stages: ExecutionStage[];
}

/**
 * 模型提供器工厂
 */
export type ModelProviderFactory = (modelAlias: string) => LLMProvider;

/**
 * ModelOrchestrator - 多模型协作调度器
 * 负责任务分析、模型选择、执行协调和结果整合
 */
export class ModelOrchestrator {
  private config: OrchestratorConfig;
  private taskAnalyzer: TaskAnalyzer;
  private capabilityManager: ModelCapabilityManager;
  private contextManager: SharedContextManager;
  private providerFactory: ModelProviderFactory;

  constructor(
    config: OrchestratorConfig,
    providerFactory: ModelProviderFactory,
    customCapabilities?: Record<string, any>
  ) {
    this.config = config;
    this.providerFactory = providerFactory;

    // 初始化任务分析器
    const analyzerModel = config.analyzerModel || 'claude-haiku';
    const analyzerProvider = providerFactory(analyzerModel);
    this.taskAnalyzer = new TaskAnalyzer(analyzerProvider, analyzerModel);

    // 初始化能力管理器
    this.capabilityManager = new ModelCapabilityManager(customCapabilities);

    // 初始化上下文管理器
    const summarizerModel = config.contextSharing.summarizerModel || 'claude-haiku';
    const summarizerProvider = providerFactory(summarizerModel);
    this.contextManager = new SharedContextManager(summarizerProvider, summarizerModel);
  }

  /**
   * 执行多模型协作
   * @param userInput 用户输入
   * @param context 历史对话上下文
   * @returns 协作执行结果
   */
  async execute(userInput: string, context: Message[]): Promise<OrchestratedResponse> {
    const startTime = Date.now();

    // 1. 分析任务
    const analysis = await this.taskAnalyzer.analyzeTask(userInput, context);

    // 如果只有一个任务且置信度高，直接执行（优化路径）
    if (analysis.tasks.length === 1 && analysis.tasks[0].confidence > 0.8) {
      const singleTask = analysis.tasks[0];
      const model = this.selectBestModel(singleTask);
      const result = await this.executeTask(
        { task: singleTask, model, taskIndex: 0 },
        [],
        context
      );

      return {
        results: [result],
        synthesizedOutput: result.output,
        metadata: {
          totalLatency: Date.now() - startTime,
          totalTokensUsed: result.metadata?.tokensUsed || 0,
          totalCost: result.metadata?.cost || 0,
          modelsUsed: [model],
        },
      };
    }

    // 2. 为每个子任务选择最佳模型
    const taskAssignments = analysis.tasks.map((task, index) => ({
      task,
      model: this.selectBestModel(task),
      taskIndex: index,
    }));

    // 3. 构建执行图
    const executionGraph = this.buildExecutionGraph(taskAssignments, analysis.suggestedWorkflow);

    // 4. 执行任务
    const results: TaskResult[] = [];
    for (const stage of executionGraph.stages) {
      if (stage.mode === 'parallel') {
        // 并行执行
        const stageResults = await Promise.all(
          stage.tasks.map((assignment) => this.executeTask(assignment, results, context))
        );
        results.push(...stageResults);
      } else {
        // 顺序执行
        for (const assignment of stage.tasks) {
          const result = await this.executeTask(assignment, results, context);
          results.push(result);
        }
      }
    }

    // 5. 整合结果
    const synthesizedOutput = await this.synthesizeResults(results, userInput, context);

    // 6. 计算元数据
    const metadata = this.calculateMetadata(results, startTime);

    return {
      results,
      synthesizedOutput,
      metadata,
    };
  }

  /**
   * 选择最佳模型
   */
  private selectBestModel(task: AnalyzedTask): string {
    // 1. 检查是否有明确的路由规则
    const routingRule = this.config.taskRouting.find((rule) => rule.taskType === task.type);
    if (routingRule) {
      // 优先使用配置的首选模型
      for (const preferredModel of routingRule.preferredModels) {
        const capability = this.capabilityManager.getCapability(preferredModel);
        if (capability) {
          // 检查视觉要求
          if (task.requiresVision && !capability.features.supportsVision) {
            continue;
          }
          return preferredModel;
        }
      }

      // 使用备选模型
      if (routingRule.fallbackModel) {
        const fallbackCapability = this.capabilityManager.getCapability(routingRule.fallbackModel);
        if (fallbackCapability && (!task.requiresVision || fallbackCapability.features.supportsVision)) {
          return routingRule.fallbackModel;
        }
      }
    }

    // 2. 自动选择：基于能力评分
    const candidates = this.capabilityManager
      .getAllCapabilities()
      .filter((cap) => {
        // 基本能力过滤
        if (task.requiresVision && !cap.features.supportsVision) {
          return false;
        }
        return true;
      })
      .map((cap) => ({
        model: cap.modelAlias,
        score: this.calculateModelScore(cap, task),
      }))
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.model ?? 'claude-sonnet'; // 默认模型
  }

  /**
   * 计算模型-任务匹配分数
   */
  private calculateModelScore(capability: any, task: AnalyzedTask): number {
    // 基础分：任务类型匹配
    let score = capability.strengths.includes(task.type) ? 50 : 0;

    // 能力分
    const relevantScoreKey = this.getScoreKeyForTaskType(task.type);
    const relevantScore = capability.scores[relevantScoreKey] ?? 50;
    score += relevantScore * 0.3;

    // 速度分（简单任务优先快的）
    if (task.estimatedComplexity === 'low') {
      score += capability.scores.speed * 0.2;
    }

    // 成本分
    score += capability.scores.cost * 0.1;

    // 复杂度匹配（高复杂度任务优先高能力模型）
    if (task.estimatedComplexity === 'high') {
      score += relevantScore * 0.1;
    }

    return score;
  }

  /**
   * 根据任务类型获取评分键
   */
  private getScoreKeyForTaskType(taskType: string): string {
    const mapping: Record<string, string> = {
      coding: 'coding',
      code_review: 'coding',
      debugging: 'coding',
      image_analysis: 'vision',
      reasoning: 'reasoning',
      data_analysis: 'reasoning',
      creative_writing: 'creativity',
      translation: 'speed',
      summarization: 'speed',
      general_qa: 'reasoning',
    };
    return mapping[taskType] ?? 'reasoning';
  }

  /**
   * 构建执行图
   */
  private buildExecutionGraph(
    assignments: TaskAssignment[],
    suggestedWorkflow: OrchestrationMode
  ): ExecutionGraph {
    const mode = this.config.mode === 'hybrid' ? suggestedWorkflow : this.config.mode;

    if (mode === 'parallel') {
      // 全部并行
      return {
        stages: [{ mode: 'parallel', tasks: assignments }],
      };
    }

    if (mode === 'sequential') {
      // 全部顺序
      return {
        stages: assignments.map((assignment) => ({
          mode: 'sequential' as const,
          tasks: [assignment],
        })),
      };
    }

    // hybrid 模式：根据依赖关系构建阶段
    const stages: ExecutionStage[] = [];
    const processed = new Set<number>();

    while (processed.size < assignments.length) {
      const currentStage: TaskAssignment[] = [];

      for (const assignment of assignments) {
        if (processed.has(assignment.taskIndex)) continue;

        // 检查依赖是否都已处理
        const allDependenciesMet = assignment.task.dependencies.every((dep) => processed.has(dep));

        if (allDependenciesMet) {
          currentStage.push(assignment);
          processed.add(assignment.taskIndex);
        }
      }

      if (currentStage.length === 0) break; // 防止死循环

      stages.push({
        mode: currentStage.length > 1 ? 'parallel' : 'sequential',
        tasks: currentStage,
      });
    }

    return { stages };
  }

  /**
   * 执行单个任务
   */
  private async executeTask(
    assignment: TaskAssignment,
    previousResults: TaskResult[],
    originalContext: Message[]
  ): Promise<TaskResult> {
    const { task, model } = assignment;
    const startTime = Date.now();

    try {
      // 1. 构建任务上下文
      const taskContext = await this.buildTaskContext(task, previousResults, originalContext);

      // 2. 获取模型提供器
      const provider = this.providerFactory(model);

      // 3. 执行任务
      const response = await provider.chat(taskContext);

      // 4. 构建结果
      const result: TaskResult = {
        task,
        model,
        output: response.content,
        metadata: {
          latency: Date.now() - startTime,
          tokensUsed: this.estimateTokens(response.content),
          cost: calculateRequestCost(
            getModelPricing(model),
            { inputTokens: this.estimateTokens(response.content), outputTokens: Math.round(response.content.length / 4) },
          ),
        },
      };

      return result;
    } catch (error) {
      console.error(`[ModelOrchestrator] Task execution failed for ${model}:`, error);

      // 返回错误结果
      return {
        task,
        model,
        output: `任务执行失败: ${error instanceof Error ? error.message : String(error)}`,
        metadata: {
          latency: Date.now() - startTime,
          tokensUsed: 0,
          cost: 0,
        },
      };
    }
  }

  /**
   * 构建任务上下文
   */
  private async buildTaskContext(
    task: AnalyzedTask,
    previousResults: TaskResult[],
    originalContext: Message[]
  ): Promise<Message[]> {
    const context: Message[] = [...originalContext];

    // 添加依赖任务的结果
    for (const depIndex of task.dependencies) {
      const depResult = previousResults.find((r) => previousResults.indexOf(r) === depIndex);
      if (depResult) {
        const sharedMessages = await this.contextManager.shareContext(
          depResult.model,
          'current',
          depResult,
          this.config.contextSharing.strategy
        );
        context.push(...sharedMessages);
      }
    }

    // 添加任务描述
    context.push({
      role: 'user',
      content: `请完成以下任务:\n\n任务类型: ${task.type}\n任务描述: ${task.description}\n复杂度: ${task.estimatedComplexity}`,
    });

    // 检查并调整上下文长度
    const maxTokens = this.config.contextSharing.maxSharedTokens;
    return this.contextManager.adjustContextForTokenLimit(context, maxTokens);
  }

  /**
   * 整合多个任务结果
   */
  private async synthesizeResults(
    results: TaskResult[],
    userInput: string,
    context: Message[]
  ): Promise<string> {
    // 如果只有一个结果，直接返回
    if (results.length === 1) {
      return results[0].output;
    }

    // 使用高能力模型整合结果
    const synthesizerModel = 'claude-sonnet';
    const provider = this.providerFactory(synthesizerModel);

    const synthesisPrompt = `请整合以下多个子任务的执行结果，生成一个连贯、完整的回答。

用户原始问题: ${userInput}

子任务结果:
${results
  .map(
    (r, i) =>
      `${i + 1}. [${r.task.type}] (由 ${r.model} 完成)
${r.output}
`
  )
  .join('\n---\n\n')}

请将上述结果整合成一个自然、流畅的回答，确保:
1. 保留所有重要信息
2. 逻辑连贯
3. 直接回答用户问题`;

    try {
      const response = await provider.chat([{ role: 'user', content: synthesisPrompt }]);
      return response.content;
    } catch (error) {
      console.error('[ModelOrchestrator] Result synthesis failed:', error);
      // 降级：简单拼接
      return results.map((r, i) => `${i + 1}. ${r.output}`).join('\n\n');
    }
  }

  /**
   * 计算元数据
   */
  private calculateMetadata(
    results: TaskResult[],
    startTime: number
  ): OrchestratedResponse['metadata'] {
    const totalLatency = Date.now() - startTime;
    const totalTokensUsed = results.reduce((sum, r) => sum + (r.metadata?.tokensUsed || 0), 0);
    const totalCost = results.reduce((sum, r) => sum + (r.metadata?.cost || 0), 0);
    const modelsUsed = [...new Set(results.map((r) => r.model))];

    return {
      totalLatency,
      totalTokensUsed,
      totalCost,
      modelsUsed,
    };
  }

  /**
   * 估算 token 数量（粗略）
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 2.5);
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...config };

    // 更新相关组件
    if (config.analyzerModel) {
      this.taskAnalyzer.setAnalyzerModel(config.analyzerModel);
    }

    if (config.contextSharing?.summarizerModel) {
      const summarizerProvider = this.providerFactory(config.contextSharing.summarizerModel);
      this.contextManager.setSummarizer(summarizerProvider, config.contextSharing.summarizerModel);
    }
  }

  /**
   * 获取当前配置
   */
  getConfig(): OrchestratorConfig {
    return { ...this.config };
  }

  /**
   * 获取能力管理器（用于查询模型能力）
   */
  getCapabilityManager(): ModelCapabilityManager {
    return this.capabilityManager;
  }

  /**
   * 获取上下文管理器（用于管理共享上下文）
   */
  getContextManager(): SharedContextManager {
    return this.contextManager;
  }
}
