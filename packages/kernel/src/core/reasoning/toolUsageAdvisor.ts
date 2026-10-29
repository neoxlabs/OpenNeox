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
    /** readfile paths=[...] 一次读了多个 */
    multi?: boolean;
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
        const multi = Array.isArray(args?.paths) && (args.paths as unknown[]).length > 1;
        this.recentCalls.push({ name: toolName, success, filePath, iteration, multi });
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
    analyze(currentIteration: number, requireMutation = true): string | null {
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
            || (requireMutation ? this.detectReadOnlyPattern(recent) : null);

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

        const readsPerIteration = new Map<number, ToolCallSnapshot[]>();
        for (const c of readCalls) readsPerIteration.set(c.iteration, [...(readsPerIteration.get(c.iteration) ?? []), c]);
        const singles = [...readsPerIteration.values()].filter(g => g.length === 1 && !g[0].multi).map(g => g[0]);

        // 检查是否在读不同文件（而不是同一文件的不同范围）
        const uniqueFiles = new Set(singles.map(c => c.filePath).filter(Boolean));
        if (uniqueFiles.size < 3) return null;

        this.suppressedAdvice.add('batch_read_to_search');
        return [
            `[EFFICIENCY TIP] You have read ${uniqueFiles.size} different files one call at a time.`,
            'Read several at once (one shell `cat a b c`, or readfile paths=[...]); if you are hunting for a pattern, search finds it faster; '
                + 'for layout, `git ls-files` or `ls` in the shell.',
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
            `[SEARCH TIP] ${failedSearches.length} searches in a row found nothing.`,
            'Try a shorter keyword or a different term, or look at the layout with `git ls-files` / `ls` in the shell.',
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
            `[EDIT TIP] ${repeatedFile[1]} edits on ${repeatedFile[0]}, some failed.`,
            'A failed edit almost always means old_string no longer matches the file: re-read that part and copy the text exactly. '
                + 'Several changes in one file go in ONE edit call with hunks=[...].',
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

        // 递进式提醒 (只在用户要改东西时才会走到这, 见 analyze)
        if (this.readOnlyNudgeCount <= 1) {
            return [
                `[PROGRESS TIP] ${recentCalls.length} read/search calls in a row.`,
                'You likely understand enough to start the change — 80% is enough, fill gaps as you go.',
            ].join('\n');
        }

        return [
            `[PROGRESS TIP] ${this.recentCalls.length} read-only calls and no change yet.`,
            'Start the change now. If something specific is still missing, say what it is in one line.',
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
