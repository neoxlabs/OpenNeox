import type {
  TaskAnalysis,
  AnalyzedTask,
  TaskType,
  OrchestrationMode,
} from '@neoxlabs/platform/utils/config.js';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMProvider {
  chat(messages: Message[], options?: { temperature?: number; maxTokens?: number }): Promise<{ content: string }>;
}

/**
 * TaskAnalyzer - 任务分析器
 * 分析用户输入，识别任务类型和子任务
 */
export class TaskAnalyzer {
  private analyzerModel: string;
  private llmProvider: LLMProvider;

  constructor(llmProvider: LLMProvider, analyzerModel: string = 'claude-haiku') {
    this.llmProvider = llmProvider;
    this.analyzerModel = analyzerModel;
  }

  /**
   * 分析用户输入，识别任务类型和子任务
   * @param input 用户输入
   * @param context 历史对话上下文（可选）
   * @returns 任务分析结果
   */
  async analyzeTask(input: string, context?: Message[]): Promise<TaskAnalysis> {
    const prompt = this.buildAnalysisPrompt(input, context);

    try {
      const response = await this.llmProvider.chat(
        [{ role: 'user', content: prompt }],
        { temperature: 0.3, maxTokens: 2000 }
      );

      // 解析 JSON 响应
      const analysis = this.parseAnalysisResponse(response.content);
      return analysis;
    } catch (error) {
      // 如果分析失败，返回默认的单任务分析
      console.error('[TaskAnalyzer] Analysis failed, using fallback:', error);
      return this.createFallbackAnalysis(input);
    }
  }

  /**
   * 构建任务分析提示词
   */
  private buildAnalysisPrompt(input: string, context?: Message[]): string {
    const contextSummary = context && context.length > 0
      ? `\n历史对话摘要:\n${context.slice(-3).map(m => `${m.role}: ${m.content.slice(0, 100)}`).join('\n')}`
      : '';

    return `你是一个任务分析专家。请分析以下用户请求，识别任务类型和子任务。

用户输入: ${input}${contextSummary}

任务类型包括:
- image_analysis: 图像分析
- coding: 代码编写
- code_review: 代码审查
- debugging: 调试
- reasoning: 复杂推理
- creative_writing: 创意写作
- summarization: 摘要总结
- translation: 翻译
- data_analysis: 数据分析
- general_qa: 通用问答

请返回 JSON 格式的分析结果:
{
  "tasks": [
    {
      "type": "任务类型 (从上述列表选择)",
      "description": "任务描述",
      "confidence": 0.0-1.0 (置信度),
      "dependencies": [依赖的其他任务索引],
      "requiresVision": true/false,
      "estimatedComplexity": "low/medium/high"
    }
  ],
  "suggestedWorkflow": "sequential/parallel/hybrid"
}

注意:
1. 如果任务可以拆分成多个子任务,请列出所有子任务
2. dependencies 数组中的数字表示依赖的任务索引(从0开始)
3. requiresVision 表示是否需要视觉能力(如图像识别)
4. suggestedWorkflow 表示建议的执行方式:
   - sequential: 必须按顺序执行
   - parallel: 可以并行执行
   - hybrid: 混合模式(部分并行,部分顺序)

只返回 JSON,不要有其他文字。`;
  }

  /**
   * 解析分析响应
   */
  private parseAnalysisResponse(response: string): TaskAnalysis {
    try {
      // 尝试提取 JSON (处理可能的 markdown 包装)
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, response];
      const jsonStr = jsonMatch[1] || response;

      const parsed = JSON.parse(jsonStr.trim());

      // 验证结构
      if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
        throw new Error('Invalid response structure: missing tasks array');
      }

      // 验证每个任务
      parsed.tasks.forEach((task: any, index: number) => {
        if (!task.type || !this.isValidTaskType(task.type)) {
          throw new Error(`Invalid task type at index ${index}: ${task.type}`);
        }
        task.confidence = Math.max(0, Math.min(1, task.confidence || 0.7));
        task.dependencies = Array.isArray(task.dependencies) ? task.dependencies : [];
        task.requiresVision = Boolean(task.requiresVision);
        task.estimatedComplexity = task.estimatedComplexity || 'medium';
      });

      // 验证 workflow
      if (!['sequential', 'parallel', 'hybrid'].includes(parsed.suggestedWorkflow)) {
        parsed.suggestedWorkflow = 'sequential';
      }

      return parsed as TaskAnalysis;
    } catch (error) {
      console.error('[TaskAnalyzer] Failed to parse response:', error);
      throw error;
    }
  }

  /**
   * 验证任务类型是否有效
   */
  private isValidTaskType(type: string): type is TaskType {
    const validTypes: TaskType[] = [
      'image_analysis',
      'coding',
      'code_review',
      'debugging',
      'reasoning',
      'creative_writing',
      'summarization',
      'translation',
      'data_analysis',
      'general_qa',
    ];
    return validTypes.includes(type as TaskType);
  }

  /**
   * 创建降级分析结果（当分析失败时使用）
   */
  private createFallbackAnalysis(input: string): TaskAnalysis {
    // 简单的规则基础分析
    const lowerInput = input.toLowerCase();
    let taskType: TaskType = 'general_qa';
    let requiresVision = false;
    let complexity: 'low' | 'medium' | 'high' = 'medium';

    // 简单的关键词匹配
    if (lowerInput.includes('代码') || lowerInput.includes('code') || lowerInput.includes('编程')) {
      taskType = 'coding';
      complexity = 'high';
    } else if (lowerInput.includes('审查') || lowerInput.includes('review')) {
      taskType = 'code_review';
      complexity = 'medium';
    } else if (lowerInput.includes('bug') || lowerInput.includes('错误') || lowerInput.includes('调试')) {
      taskType = 'debugging';
      complexity = 'high';
    } else if (lowerInput.includes('图片') || lowerInput.includes('图像') || lowerInput.includes('image')) {
      taskType = 'image_analysis';
      requiresVision = true;
      complexity = 'medium';
    } else if (lowerInput.includes('翻译') || lowerInput.includes('translate')) {
      taskType = 'translation';
      complexity = 'low';
    } else if (lowerInput.includes('总结') || lowerInput.includes('摘要') || lowerInput.includes('summarize')) {
      taskType = 'summarization';
      complexity = 'low';
    } else if (lowerInput.includes('分析') || lowerInput.includes('analyze') || lowerInput.includes('数据')) {
      taskType = 'data_analysis';
      complexity = 'high';
    }

    const task: AnalyzedTask = {
      type: taskType,
      description: input,
      confidence: 0.6, // 降级分析的置信度较低
      dependencies: [],
      requiresVision,
      estimatedComplexity: complexity,
    };

    return {
      tasks: [task],
      suggestedWorkflow: 'sequential',
    };
  }

  /**
   * 更新分析器使用的模型
   */
  setAnalyzerModel(model: string): void {
    this.analyzerModel = model;
  }

  /**
   * 获取当前使用的分析器模型
   */
  getAnalyzerModel(): string {
    return this.analyzerModel;
  }
}
