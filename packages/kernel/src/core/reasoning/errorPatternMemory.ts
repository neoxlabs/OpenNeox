/**
 * ErrorPatternMemory — 错误模式记忆 + 递进式策略升级
 *
 * 替代原有的 toolFailureCounts + 静态 buildEditFailureHint：
 * - 记录每次失败的具体错误类型（匹配失败 / 路径不存在 / 语法错误 / 权限）
 * - 根据失败次数和模式，生成递进式恢复策略
 * - 第 2 次：温和建议（重读文件）
 * - 第 3 次：强制切换策略（write_file 覆写）
 * - 第 4 次+：升级到向用户求助
 *
 * 设计原则：
 * 1. 不重复同样的提示 — 每次升级给出新的、更具体的策略
 * 2. 基于实际错误分类 — 不同错误类型给不同建议
 * 3. 跨工具关联 — 如果 edit_file 和 search 都在同一文件失败，关联分析
 */

/** 错误分类 */
export type ErrorCategory =
    | 'match_failed'    // old_string 不匹配（edit_file 最常见）
    | 'not_found'       // 文件/路径不存在
    | 'permission'      // 权限拒绝
    | 'syntax'          // 语法/格式错误
    | 'timeout'         // 超时
    | 'no_results'      // 搜索无结果
    | 'already_done'    // 重复操作
    | 'unknown';        // 未分类

/** 单次失败记录 */
interface FailureRecord {
    toolName: string;
    category: ErrorCategory;
    filePath?: string;
    errorPreview: string;     // 错误信息前 200 字符
    args?: Record<string, unknown>;
    timestamp: number;
    iteration: number;
}

/** 工具级别的累积统计 */
interface ToolFailureStats {
    consecutiveFailures: number;
    totalFailures: number;
    lastCategory: ErrorCategory;
    lastFilePath?: string;
    categories: Map<ErrorCategory, number>;  // 每种错误类型的计数
    strategiesAttempted: Set<string>;        // 已经建议过的策略
}

export class ErrorPatternMemory {
    private history: FailureRecord[] = [];
    private stats: Map<string, ToolFailureStats> = new Map();
    private maxHistory = 30;

    /**
     * 记录一次工具失败
     */
    recordFailure(
        toolName: string,
        errorOutput: string,
        args?: Record<string, unknown>,
        iteration: number = 0,
    ): void {
        const category = this.classifyError(toolName, errorOutput);
        const filePath = this.extractFilePath(toolName, args);
        // Defensive shallow clone: 防止外部在 record 之后 mutate args 污染历史。
        // Node single-thread 下没有 data race, 但跨 iteration 引用同一对象的
        // 语义陷阱确实存在 —— 这个 clone 是防御性的惯用法,不是锁。
        const record: FailureRecord = {
            toolName,
            category,
            filePath,
            errorPreview: errorOutput.slice(0, 200),
            args: args ? { ...args } : undefined,
            timestamp: Date.now(),
            iteration,
        };

        this.history.push(record);
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }

        // 更新工具级统计
        const existing = this.stats.get(toolName) || {
            consecutiveFailures: 0,
            totalFailures: 0,
            lastCategory: 'unknown' as ErrorCategory,
            lastFilePath: undefined,
            categories: new Map<ErrorCategory, number>(),
            strategiesAttempted: new Set<string>(),
        };

        existing.consecutiveFailures++;
        existing.totalFailures++;
        existing.lastCategory = category;
        existing.lastFilePath = filePath;
        existing.categories.set(category, (existing.categories.get(category) || 0) + 1);
        this.stats.set(toolName, existing);
    }

    /**
     * 记录一次工具成功 — 重置该工具的连续失败计数
     */
    recordSuccess(toolName: string): void {
        const existing = this.stats.get(toolName);
        if (existing) {
            existing.consecutiveFailures = 0;
            existing.strategiesAttempted.clear();
        }
    }

    /**
     * 获取连续失败次数
     */
    getConsecutiveFailures(toolName: string): number {
        return this.stats.get(toolName)?.consecutiveFailures ?? 0;
    }

    /**
     * 生成递进式错误恢复提示
     * @returns null 表示不需要注入提示（首次失败或已成功）
     */
    buildEscalatedHint(toolName: string, filePath?: string): string | null {
        const stats = this.stats.get(toolName);
        if (!stats || stats.consecutiveFailures < 2) {
            return null; // 首次失败不注入（工具本身已返回错误信息）
        }

        const attempt = stats.consecutiveFailures;
        const category = stats.lastCategory;
        const targetFile = filePath || stats.lastFilePath || '目标文件';

        // 根据工具类型和失败次数生成递进式策略
        if (toolName === 'edit' || toolName === 'edit_file' || toolName === 'Edit') {
            return this.buildEditEscalation(attempt, category, targetFile, stats);
        }

        if (toolName === 'search' || toolName === 'search_files' || toolName === 'grep' || toolName === 'Grep') {
            return this.buildSearchEscalation(attempt, category, stats);
        }

        if (toolName === 'execute_shell' || toolName === 'bash' || toolName === 'Bash') {
            return this.buildShellEscalation(attempt, category, stats);
        }

        if (toolName === 'readfile' || toolName === 'Read') {
            return this.buildReadEscalation(attempt, category, targetFile, stats);
        }

        // 通用工具失败
        return this.buildGenericEscalation(toolName, attempt, category, stats);
    }

    // ========================================================================
    // 各工具类型的递进式策略
    // ========================================================================

    private buildEditEscalation(attempt: number, category: ErrorCategory, filePath: string, stats: ToolFailureStats): string | null {
        if (attempt === 2) {
            if (category === 'match_failed') {
                stats.strategiesAttempted.add('re-read');
                return [
                    '[ERROR RECOVERY — edit 第 2 次失败]',
                    `文件: ${filePath}`,
                    '原因: old_string 不匹配。',
                    '',
                    '必须执行:',
                    `1. 先调用 readfile("${filePath}") 重新获取最新内容`,
                    '2. 精确复制需要替换的文本（包括空格、缩进、换行）',
                    '3. 缩小匹配范围 — 只匹配 2-5 行，不要匹配大段代码',
                    '',
                    '常见陷阱: tab vs 空格、行尾空格、Windows 换行符(\\r\\n)',
                ].join('\n');
            }
            if (category === 'not_found') {
                return [
                    '[ERROR RECOVERY — edit 第 2 次失败]',
                    `文件 ${filePath} 不存在或路径错误。`,
                    '',
                    '必须执行:',
                    '1. 用 show_tree 或 search 确认文件实际路径',
                    '2. 注意: 路径区分大小写，检查扩展名',
                ].join('\n');
            }
            return [
                '[ERROR RECOVERY — edit 第 2 次失败]',
                `文件: ${filePath}`,
                '',
                '请先用 readfile 确认文件当前状态，理解错误原因后再重试。',
            ].join('\n');
        }

        if (attempt === 3) {
            stats.strategiesAttempted.add('force-write');
            return [
                '[ERROR RECOVERY — edit 第 3 次失败 ⚠️ 策略升级]',
                `文件: ${filePath}`,
                '',
                '⚠️ edit 已连续失败 3 次。强制切换策略:',
                `1. 先 readfile("${filePath}") 获取完整文件内容`,
                '2. 在内容中做修改',
                '3. 用 write_file 覆写整个文件（不要再用 edit）',
                '',
                '这样虽然覆写整个文件，但能保证修改一定生效。',
            ].join('\n');
        }

        if (attempt >= 4) {
            return [
                `[ERROR RECOVERY — edit 已失败 ${attempt} 次 🚨 请停下]`,
                `文件: ${filePath}`,
                '',
                '🚨 多次失败表明可能存在根本性问题:',
                '- 文件可能被其他进程修改',
                '- 文件编码可能不是 UTF-8',
                '- 可能要修改的是错误的文件',
                '',
                '请向用户说明情况，列出:',
                '1. 你想做什么修改',
                '2. 遇到了什么错误',
                '3. 请用户确认文件状态或手动修改',
            ].join('\n');
        }

        return null;
    }

    private buildSearchEscalation(attempt: number, category: ErrorCategory, stats: ToolFailureStats): string | null {
        if (attempt === 2) {
            return [
                '[SEARCH RECOVERY — 连续 2 次搜索未找到结果]',
                '',
                '建议调整搜索策略:',
                '1. 用更短、更通用的关键词（去掉限定词）',
                '2. 用 show_tree 先看目录结构，确认搜索范围',
                '3. 如果找类定义/函数名，用 glob 模式匹配文件名',
                '4. 检查拼写: 确认搜索词没有拼写错误',
            ].join('\n');
        }

        if (attempt >= 3) {
            return [
                `[SEARCH RECOVERY — 连续 ${attempt} 次搜索失败 ⚠️]`,
                '',
                '搜索策略需要根本性调整:',
                '1. 用 show_tree 浏览项目结构，手动找到相关目录',
                '2. 直接 readfile 可能的候选文件',
                '3. 考虑: 你要找的内容可能不存在于当前代码库中',
                '4. 如果是找特定符号，尝试 grep -r "关键词" --include="*.ts"',
            ].join('\n');
        }

        return null;
    }

    private buildShellEscalation(attempt: number, category: ErrorCategory, stats: ToolFailureStats): string | null {
        if (attempt === 2) {
            return [
                '[SHELL RECOVERY — 命令连续 2 次失败]',
                '',
                '排查清单:',
                '1. 检查命令语法是否正确（特别是引号、路径分隔符）',
                '2. 确认工作目录是否正确',
                '3. 检查依赖是否安装（npm install / pip install）',
                '4. 不要盲目重试同一命令 — 先分析错误输出',
            ].join('\n');
        }

        if (attempt >= 3) {
            return [
                `[SHELL RECOVERY — 命令连续 ${attempt} 次失败 ⚠️]`,
                '',
                '请停下来分析:',
                '1. 回顾之前所有失败的命令和错误输出',
                '2. 列出你认为的失败原因',
                '3. 如果是环境问题，向用户说明并请求帮助',
                '4. 不要继续盲目重试',
            ].join('\n');
        }

        return null;
    }

    private buildReadEscalation(attempt: number, category: ErrorCategory, filePath: string, stats: ToolFailureStats): string | null {
        if (attempt >= 2) {
            return [
                `[READ RECOVERY — readfile 连续 ${attempt} 次失败]`,
                `文件: ${filePath}`,
                '',
                '文件可能不存在或路径错误:',
                '1. 用 show_tree 确认文件实际位置',
                '2. 用 search_files 或 glob 查找正确的文件名',
                '3. 路径区分大小写',
            ].join('\n');
        }

        return null;
    }

    private buildGenericEscalation(toolName: string, attempt: number, category: ErrorCategory, stats: ToolFailureStats): string | null {
        if (attempt === 2) {
            return [
                `[ERROR RECOVERY — ${toolName} 连续失败 ${attempt} 次]`,
                '',
                '在重试之前:',
                '1. 分析前两次失败的具体错误信息',
                '2. 确认参数是否正确',
                '3. 尝试不同的方法达成目标',
            ].join('\n');
        }

        if (attempt >= 3) {
            return [
                `[ERROR RECOVERY — ${toolName} 连续失败 ${attempt} 次 ⚠️]`,
                '',
                '多次失败需要换思路:',
                '1. 这个工具可能不适合当前场景',
                '2. 考虑用其他工具达成同样目的',
                `3. 如果 ${attempt} >= 4，向用户说明情况`,
            ].join('\n');
        }

        return null;
    }

    // ========================================================================
    // 错误分类
    // ========================================================================

    private classifyError(toolName: string, errorOutput: string): ErrorCategory {
        const lower = errorOutput.toLowerCase();

        // 匹配失败（edit_file 最常见）
        if (lower.includes('no match') || lower.includes('not found in file') ||
            lower.includes('old_string') || lower.includes('does not match') ||
            lower.includes('无法匹配') || lower.includes('匹配失败') ||
            lower.includes('string not found') || lower.includes('couldn\'t find')) {
            return 'match_failed';
        }

        // 路径不存在
        if (lower.includes('enoent') || lower.includes('no such file') ||
            lower.includes('not found') || lower.includes('does not exist') ||
            lower.includes('不存在') || lower.includes('找不到文件')) {
            return 'not_found';
        }

        // 权限
        if (lower.includes('permission denied') || lower.includes('eacces') ||
            lower.includes('权限') || lower.includes('forbidden')) {
            return 'permission';
        }

        // 语法错误
        if (lower.includes('syntax error') || lower.includes('parse error') ||
            lower.includes('unexpected token') || lower.includes('语法错误')) {
            return 'syntax';
        }

        // 超时
        if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('超时')) {
            return 'timeout';
        }

        // 搜索无结果
        if (lower.includes('no results') || lower.includes('no matches') ||
            lower.includes('no files found') || lower.includes('未找到')) {
            return 'no_results';
        }

        // 重复操作
        if (lower.includes('already') || lower.includes('no changes') ||
            lower.includes('已经') || lower.includes('unchanged')) {
            return 'already_done';
        }

        return 'unknown';
    }

    private extractFilePath(toolName: string, args?: Record<string, unknown>): string | undefined {
        if (!args) return undefined;
        return (args.path || args.file_path || args.filePath || args.file || args.target) as string | undefined;
    }

    /**
     * 获取最近的错误模式摘要（用于调试）
     */
    getRecentPatterns(): Array<{ tool: string; failures: number; lastCategory: ErrorCategory }> {
        const result: Array<{ tool: string; failures: number; lastCategory: ErrorCategory }> = [];
        for (const [tool, stats] of this.stats.entries()) {
            if (stats.consecutiveFailures > 0) {
                result.push({
                    tool,
                    failures: stats.consecutiveFailures,
                    lastCategory: stats.lastCategory,
                });
            }
        }
        return result;
    }

    /**
     * 重置（新任务开始时调用）
     */
    reset(): void {
        this.history = [];
        this.stats.clear();
    }

    /**
     *  P0: 清理过老的记录，但保留有价值的失败模式知识
     * 用于跨轮学习 — 不像 reset() 那样全部清空
     */
    trimOldPatterns(): void {
        // 只保留最近 20 条历史
        if (this.history.length > 20) {
            this.history = this.history.slice(-20);
        }
        // 清理连续失败计数为 0 的工具统计（已恢复的不需要保留）
        for (const [tool, stats] of this.stats.entries()) {
            if (stats.consecutiveFailures === 0 && stats.totalFailures > 0) {
                // 保留 totalFailures 计数但清理 strategies
                stats.strategiesAttempted.clear();
            }
        }
    }

    /**
     * crash-resume 导出:把 history + stats 转成 JSON-friendly 结构。
     * Map<..., Map|Set> 拉平成数组,这样 JSON.stringify 就能直接跑。
     */
    exportState(): ErrorPatternSnapshot {
        return {
            history: this.history.map(r => ({ ...r })),
            stats: Array.from(this.stats.entries()).map(([toolName, s]) => ({
                toolName,
                consecutiveFailures: s.consecutiveFailures,
                totalFailures: s.totalFailures,
                lastCategory: s.lastCategory,
                lastFilePath: s.lastFilePath,
                categories: Array.from(s.categories.entries()),
                strategiesAttempted: Array.from(s.strategiesAttempted),
            })),
        };
    }

    /**
     * crash-resume 导入:从持久化快照还原 history + stats。
     * 会覆盖当前实例的状态 —— 通常在新建后立即调用。
     */
    importState(snapshot: ErrorPatternSnapshot): void {
        this.history = snapshot.history.map(r => ({ ...r }));
        this.stats.clear();
        for (const s of snapshot.stats) {
            this.stats.set(s.toolName, {
                consecutiveFailures: s.consecutiveFailures,
                totalFailures: s.totalFailures,
                lastCategory: s.lastCategory,
                lastFilePath: s.lastFilePath,
                categories: new Map(s.categories),
                strategiesAttempted: new Set(s.strategiesAttempted),
            });
        }
    }
}

/**
 * ErrorPatternMemory 的持久化快照格式。
 *
 * 设计点:
 *   · 内部的 Map/Set 全部拉平成数组 —— 保证 JSON.stringify 无损
 *   · args 作为 Record<string, unknown> 已经是 JSON-friendly(见 recordFailure 的防御性 clone)
 *   · 不存 strategiesAttempted 的具体内容?存 —— 它决定下一条 hint 会不会重复
 */
export interface ErrorPatternSnapshot {
    history: Array<{
        toolName: string;
        category: ErrorCategory;
        filePath?: string;
        errorPreview: string;
        args?: Record<string, unknown>;
        timestamp: number;
        iteration: number;
    }>;
    stats: Array<{
        toolName: string;
        consecutiveFailures: number;
        totalFailures: number;
        lastCategory: ErrorCategory;
        lastFilePath?: string;
        categories: Array<[ErrorCategory, number]>;
        strategiesAttempted: string[];
    }>;
}
