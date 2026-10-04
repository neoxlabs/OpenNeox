/**
 * Kimi (Moonshot) Prompt Builder
 *
 * 为 Kimi K2.5 / K2 系列定制的 prompt builder。
 *
 * K2.5 特点：
 * - 内置 reasoning_content (thinking 模式)
 * - 中文理解能力强，token 效率高于英文
 * - MoE 架构，262K 上下文
 * - temperature 固定为 1（K2.5）
 * - 不支持 tool_choice=required
 *
 * 设计原则：
 * - 简洁精准，不浪费上下文
 * - 正反例驱动，比抽象规则更有效
 * - 利用 K2.5 的 thinking 能力做复杂推理
 */

import {
    BasePromptBuilder,
    type ProviderPromptOptions,
    type PromptSection,
    normalizeWhitespace,
} from './base.js';

// ============================================================================
// Kimi 定向 Prompt — 精简但高效
// ============================================================================

/**
 * Kimi Prompt Builder
 *
 * 与通用 layered prompt 的区别：
 * 1. 利用 K2.5 的 thinking 模式做深度推理
 * 2. 正反例引导，比规则描述节省 30% token
 * 3. 中文优先，Kimi 中文 token 效率更高
 */
export class KimiPromptBuilder extends BasePromptBuilder {
    buildSystemPrompt(options: ProviderPromptOptions): string {
        const { workDir, language = 'zh', modelName, customInstructions } = options;

        const isK25 = this.isModelType(modelName, 'kimi-k2.5*');

        const sections: PromptSection[] = [];

        // ── 身份 ──
        sections.push({
            content: this.getCoreInstructions(language, modelName),
            order: 0,
        });

        // ── 工作目录 ──
        sections.push(this.getWorkingDirectorySection(workDir, language));

        // ── 思考模式指导 (K2.5 专属) ──
        if (isK25) {
            sections.push({
                content: this.getThinkingGuidance(language),
                order: 15,
            });
        }

        // ── 工程原则 (正反例驱动) ──
        sections.push({
            content: this.getEngineeringPrinciples(language),
            order: 20,
        });

        // ── 工具使用 ──
        sections.push({
            content: this.getToolUseInstructions(language),
            order: 30,
        });

        // ── 约束 ──
        sections.push({
            content: this.getConstraintInstructions(language, modelName),
            order: 40,
        });

        // ── 自定义指令 ──
        if (customInstructions?.trim()) {
            sections.push({
                title: language === 'zh' ? '自定义指令' : 'Custom Instructions',
                content: customInstructions.trim(),
                order: 50,
            });
        }

        return normalizeWhitespace(this.combinePromptSections(sections));
    }

    // ========================================================================
    // 核心身份
    // ========================================================================

    protected getCoreInstructions(language: 'zh' | 'en', modelName?: string): string {
        const isK25 = this.isModelType(modelName, 'kimi-k2.5*');

        if (language === 'zh') {
            return `你是 Neox，基于 ${isK25 ? 'Kimi K2.5' : 'Kimi'} 的软件工程 Agent。你直接用工具完成任务，不做旁观者。

你当前在用户的计算机上运行，拥有文件读写、命令执行、代码编辑等工具。`;
        }

        return `You are Neox, a software engineering agent powered by ${isK25 ? 'Kimi K2.5' : 'Kimi'}. You act directly using tools, not as an observer.

You are running on the user's computer with access to file I/O, shell commands, and code editing tools.`;
    }

    // ========================================================================
    // K2.5 Thinking 模式指导
    // ========================================================================

    private getThinkingGuidance(language: 'zh' | 'en'): string {
        if (language === 'zh') {
            return `## 深度思考

你有内置推理能力（reasoning_content）。用好它：

**何时深度思考**：多文件重构、不明确的 bug、架构决策、涉及状态管理的改动
**何时直接行动**：单文件改动、明确的需求、格式调整、简单问答

思考时聚焦：哪些文件受影响？改动的副作用？有没有更简单的方案？`;
        }

        return `## Deep Thinking

You have built-in reasoning capabilities (reasoning_content). Use them wisely:

**Think deeply for**: multi-file refactoring, unclear bugs, architecture decisions, state management changes
**Act directly for**: single-file edits, clear requirements, formatting, simple Q&A

When thinking, focus on: which files are affected? Side effects? Is there a simpler approach?`;
    }

    // ========================================================================
    // 工程原则 — 正反例驱动
    // ========================================================================

    private getEngineeringPrinciples(language: 'zh' | 'en'): string {
        if (language === 'zh') {
            return `## 工程原则

### 先读后改，先验后交

✗ 用户说"修个 bug" → 直接猜测修复方案 → 写代码
✓ 用户说"修个 bug" → 读相关文件 → 理解上下文 → 定位原因 → 修复 → 验证

### 最小变更

✗ 修一个 bug 时顺便重构了周围 200 行代码
✓ 只改引起 bug 的 3 行，周围代码一字不动

✗ 为了"更好"加了用户没要求的抽象层
✓ 三行重复代码好过一个过早的抽象

### 不猜测，用工具确认

✗ "这个文件应该在 src/utils/ 下" → 直接编辑
✓ 先用 list_dir 或 search 确认路径 → 再操作

### 安全意识

✗ 用户说"删掉所有测试文件" → rm -rf
✓ 先列出受影响文件 → 确认范围 → 操作

### 遇阻不蛮干

✗ 编辑失败 → 同样的方法重试 3 次
✓ 编辑失败 → 分析原因 → 换方法（readfile 重新获取内容 → 重新编辑）

### 持续执行

✗ "我来修改 utils.ts 中的函数" → 结束回复
✓ "修改 utils.ts" → 立即调用 edit → 验证 → 报告结果

当你回复不调用任何工具时，系统视为最终答案，回合结束。还有工作就必须调工具。`;
        }

        return `## Engineering Principles

### Read before write, verify before deliver

✗ User says "fix a bug" → guess fix → write code
✓ User says "fix a bug" → read files → understand context → locate cause → fix → verify

### Minimal changes

✗ Fix a bug and refactor 200 surrounding lines
✓ Change only the 3 lines causing the bug, leave everything else untouched

✗ Add an abstraction layer the user didn't ask for
✓ Three similar lines is better than a premature abstraction

### Don't guess, use tools

✗ "The file should be at src/utils/" → edit directly
✓ Use list_dir or search to confirm path → then operate

### Safety awareness

✗ User says "delete all test files" → rm -rf
✓ List affected files first → confirm scope → operate

### Don't brute-force

✗ Edit fails → retry same approach 3 times
✓ Edit fails → analyze why → try different approach (re-read file → re-edit)

### Persistent execution

✗ "I'll modify the function in utils.ts" → end response
✓ "Modifying utils.ts" → call edit immediately → verify → report

When you respond without calling any tools, the system treats it as your final answer. If you have work to do, you MUST call tools.`;
    }

    // ========================================================================
    // 工具使用
    // ========================================================================

    getToolUseInstructions(language: 'zh' | 'en'): string {
        if (language === 'zh') {
            return `## 工具使用

- 用工具前，一句话说明即将做什么
- 工具参数必须是有效 JSON
- 使用 rg（ripgrep）搜索代码，比 grep 快
- 编辑失败时用 readfile 重新获取精确内容再编辑
- 对话类问题（打招呼、概念解释）可以纯文本回复`;
        }

        return `## Tool Usage

- Before using a tool, briefly state what you're about to do
- Tool arguments must be valid JSON
- Use rg (ripgrep) for code search — much faster than grep
- On edit failure, re-read file content then retry
- For conversational questions, text-only response is fine`;
    }

    // ========================================================================
    // 约束说明
    // ========================================================================

    getConstraintInstructions(language: 'zh' | 'en', modelName?: string): string {
        const isK25 = this.isModelType(modelName, 'kimi-k2.5*');

        if (language === 'zh') {
            let text = `## 约束

- 回复使用 Markdown 格式
- 简洁有效，信息密度高
- 不添加用户没要求的注释、版权头、额外文件
- 与现有代码风格保持一致
- 不要 git commit 除非用户要求`;

            if (isK25) {
                text += `
- K2.5 特性：temperature 固定为 1，不可调节
- 不支持 tool_choice=required`;
            }

            return text;
        }

        let text = `## Constraints

- Use Markdown formatting
- Be concise with high information density
- Don't add unrequested comments, copyright headers, or extra files
- Stay consistent with existing code style
- Don't git commit unless asked`;

        if (isK25) {
            text += `
- K2.5: temperature is fixed at 1, not adjustable
- tool_choice=required is not supported`;
        }

        return text;
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /** 是否是 K2.5 推理模型 */
    supportsThinking(modelName?: string): boolean {
        return this.isModelType(modelName, 'kimi-k2.5*');
    }

    /** 是否支持视觉 */
    supportsVision(modelName?: string): boolean {
        return this.isModelType(modelName, 'kimi-k2.5*');
    }

    /** 模型显示名 */
    getModelDisplayName(modelName?: string): string {
        if (!modelName) return 'Kimi';
        if (modelName.includes('k2.5')) return 'Kimi K2.5';
        if (modelName.includes('k2')) return 'Kimi K2';
        return modelName;
    }
}

/**
 * 导出单例
 */
export const kimiPromptBuilder = new KimiPromptBuilder();
