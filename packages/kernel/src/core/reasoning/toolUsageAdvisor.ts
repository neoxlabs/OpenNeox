/**
 * ToolUsageAdvisor — 动态工具选择提示
 *
 * 分析最近的工具调用模式，发现低效使用并给出更好的建议：
 * - 连续 readfile 多个文件 → 建议 grep/search
 * - 连续 search 无结果 → 建议换关键词/用 show_tree
 * - 连续 edit 同一文件 → 建议 write_file 一次性重写
 * - 只在读不在写 → 提醒开始执行
 *
 * 设计原则：
 * 1. 轻量检测：只看最近 N 次工具调用，O(N) 复杂度
 * 2. 不重复打扰：每种提示最多触发一次（直到模式消失）
 * 3. 提示简短：不超过 3 行，不干扰 LLM 主任务
 */

/** 工具调用快照 */
interface ToolCallSnapshot {
    name: string;
    success: boolean;
    filePath?: string;
    iteration: number;
}

/** 提示类型 */
type AdviceType =
    | 'batch_read_to_search'   // 连续读文件 → 用 search
    | 'search_fail_to_tree'    // 搜索失败 → 用 show_tree
    | 'edit_repeat_to_write'   // 反复编辑同文件 → 用 write_file
    | 'read_only_nudge'        // 只读不写 → 开始执行
    | 'slow_shell_pattern'     // 重复 shell 命令 → 缓存结果
    | 'grep_refined';          // grep 太宽泛 → 缩小范围

export class ToolUsageAdvisor {
    private recentCalls: ToolCallSnapshot[] = [];
    private maxHistory = 15;  // 只看最近 15 次
    private suppressedAdvice = new Set<AdviceType>();  // 已给出的提示（避免重复）
    /* Negative infinity means the first suggestion is not delayed by cooldown. */
    private lastAdviceIteration = Number.NEGATIVE_INFINITY;
    /* Suggestions are rate-limited to avoid interrupting the model repeatedly. */
    private static readonly ADVICE_COOLDOWN = 8;

    /**
     * 记录工具调用
     */
    record(toolName: string, success: boolean, args?: Record<string, unknown>, iteration: number = 0): void {
        const filePath = this.extractPath(args);
        this.recentCalls.push({ name: toolName, success, filePath, iteration });
        if (this.recentCalls.length > this.maxHistory) {
            this.recentCalls.shift();
        }

        // 如果模式发生变化（换了工具），重置抑制
        const recent3 = this.recentCalls.slice(-3).map(c => c.name);
        const uniqueRecent = new Set(recent3);
        if (uniqueRecent.size >= 2) {
            // 用户改变了策略，清除之前的抑制
            this.suppressedAdvice.clear();
        }
    }

    /**
     * 分析当前使用模式，返回提示（或 null）
     * 每轮最多返回一条提示
     */
    analyze(currentIteration: number): string | null {
        // 间隔至少 ADVICE_COOLDOWN 轮才给新提示（避免刷屏 + 免得频繁重注入）
        if (currentIteration - this.lastAdviceIteration < ToolUsageAdvisor.ADVICE_COOLDOWN) {
            return null;
        }

        const recent = this.recentCalls.slice(-8);
        if (recent.length < 3) return null;

        // 按优先级检测各种模式
        const advice = this.detectBatchReadPattern(recent)
            || this.detectSearchFailPattern(recent)
            || this.detectEditRepeatPattern(recent)
            || this.detectReadOnlyPattern(recent);

        if (advice) {
            this.lastAdviceIteration = currentIteration;
        }

        return advice;
    }

    // ========================================================================
    // 模式检测
    // ========================================================================

    /**
     * 模式 1: 连续 readfile 3+ 个不同文件 → 建议用 search/grep
     */
    private detectBatchReadPattern(recent: ToolCallSnapshot[]): string | null {
        if (this.suppressedAdvice.has('batch_read_to_search')) return null;

        const readCalls = recent.filter(c =>
            (c.name === 'readfile' || c.name === 'Read') && c.success
        );

        if (readCalls.length < 3) return null;

        // 检查是否在读不同文件（而不是同一文件的不同范围）
        const uniqueFiles = new Set(readCalls.map(c => c.filePath).filter(Boolean));
        if (uniqueFiles.size < 3) return null;

        this.suppressedAdvice.add('batch_read_to_search');
        return [
            '[EFFICIENCY TIP] 你已连续读取 ' + uniqueFiles.size + ' 个不同文件。',
            '如果在查找特定代码模式，grep/search 更快。',
            '如果在了解项目结构，show_tree 一次搞定。',
        ].join('\n');
    }

    /**
     * 模式 2: 连续 2+ 次搜索失败 → 建议调整策略
     */
    private detectSearchFailPattern(recent: ToolCallSnapshot[]): string | null {
        if (this.suppressedAdvice.has('search_fail_to_tree')) return null;

        const searchTools = ['search', 'search_files', 'grep', 'Grep', 'Search'];
        const recentSearches = recent.filter(c => searchTools.includes(c.name));

        if (recentSearches.length < 2) return null;

        const failedSearches = recentSearches.filter(c => !c.success);
        if (failedSearches.length < 2) return null;

        this.suppressedAdvice.add('search_fail_to_tree');
        return [
            '[SEARCH TIP] 连续 ' + failedSearches.length + ' 次搜索未找到结果。',
            '建议: 1) 缩短关键词  2) show_tree 先看目录结构  3) 用 glob 匹配文件名',
        ].join('\n');
    }

    /**
     * 模式 3: 对同一文件连续 edit 2+ 次（尤其是失败后重试）
     */
    private detectEditRepeatPattern(recent: ToolCallSnapshot[]): string | null {
        if (this.suppressedAdvice.has('edit_repeat_to_write')) return null;

        const editCalls = recent.filter(c =>
            c.name === 'edit' || c.name === 'edit_file' || c.name === 'Edit'
        );

        if (editCalls.length < 3) return null;

        // 检查是否对同一文件
        const fileCounts = new Map<string, number>();
        for (const call of editCalls) {
            if (call.filePath) {
                fileCounts.set(call.filePath, (fileCounts.get(call.filePath) || 0) + 1);
            }
        }

        const repeatedFile = [...fileCounts.entries()].find(([_, count]) => count >= 3);
        if (!repeatedFile) return null;

        // 如果其中有失败的，才建议
        const hasFailures = editCalls.some(c => c.filePath === repeatedFile[0] && !c.success);
        if (!hasFailures) return null;

        this.suppressedAdvice.add('edit_repeat_to_write');
        return [
            `[EFFICIENCY TIP] 对 ${repeatedFile[0]} 已调用 ${repeatedFile[1]} 次 edit。`,
            '如果多处修改，考虑: readfile → 一次性修改 → write_file 覆写整个文件，效率更高。',
        ].join('\n');
    }

    /**
     * 模式 4: 连续 5+ 次纯读操作没有任何写操作 → 提醒开始执行
     *
     * 修复：
     * 1. 降低触发门槛从 8 到 5（配合 prompt 中的探索预算）
     * 2. 不永久抑制，允许重复触发（通过 lastAdviceIteration 冷却控制频率）
     * 3. 消息递进：第一次温和建议，后续更强烈
     */
    private readOnlyNudgeCount = 0;

    private detectReadOnlyPattern(recent: ToolCallSnapshot[]): string | null {
        // 不永久抑制：read_only_nudge 允许重复触发
        // 频率由 lastAdviceIteration 的 2 轮冷却控制

        const readTools = new Set([
            'readfile', 'Read', 'search', 'search_files', 'grep', 'Grep',
            'show_tree', 'glob', 'Glob', 'explore',
        ]);
        const writeTools = new Set([
            'write_file', 'Write', 'edit', 'edit_file', 'Edit',
            'execute_shell', 'bash', 'Bash', 'delete_file',
        ]);

        const recentCalls = this.recentCalls.slice(-6);
        if (recentCalls.length < 5) return null;

        const hasWrite = recentCalls.some(c => writeTools.has(c.name));
        const allRead = recentCalls.every(c => readTools.has(c.name));

        if (hasWrite || !allRead) return null;

        // 降低门槛：前 5 次读取后就检测（不再等到 8 次）
        if (this.recentCalls.length < 5) return null;

        this.readOnlyNudgeCount++;

        // 递进式提醒
        if (this.readOnlyNudgeCount <= 1) {
            return [
                '[PROGRESS TIP] 已连续进行 ' + recentCalls.length + ' 次读取/搜索操作。',
                '你可能已有足够的理解来开始修改。80% 把握就够了——边做边补充理解。',
            ].join('\n');
        }

        return [
            '[ACTION REQUIRED] 连续 ' + this.recentCalls.length + ' 次纯读取操作，没有任何修改。',
            '停止继续读取。立即开始 edit 或 write_file。如果确实还不够理解，说明具体缺什么信息。',
        ].join('\n');
    }

    // ========================================================================
    // 工具函数
    // ========================================================================

    private extractPath(args?: Record<string, unknown>): string | undefined {
        if (!args) return undefined;
        return (args.path || args.file_path || args.filePath || args.file || args.target) as string | undefined;
    }

    /**
     * 重置（新任务开始时调用）
     */
    reset(): void {
        this.recentCalls = [];
        this.suppressedAdvice.clear();
        this.lastAdviceIteration = Number.NEGATIVE_INFINITY;   // 见字段声明: 不能用 0
        this.readOnlyNudgeCount = 0;
    }
}
