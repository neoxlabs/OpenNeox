/**
 * Tool Call Repair System
 *
 * 三层防御架构：
 * 1. XML 碎片检测 — 检测文本输出中的残缺工具调用标签
 * 2. 工具名修复 — 修复大小写错误、别名映射
 * 3. 参数修复 — 交给已有的 toolArgsParser 处理
 *
 * 设计原则：
 * - 静默修复，不影响用户体验
 * - 修复后继续循环，不终止任务
 * - 所有修复操作记录日志，便于调试
 */

import { cliLogger } from '../platform/cliLogger.js';

// ==================== XML 碎片检测 ====================

/**
 * 检测文本中是否包含工具调用的 XML/标签碎片
 * 这通常意味着模型试图调用工具但输出被截断或格式退化
 */
const MALFORMED_TOOL_PATTERNS = [
    // OpenAI/Anthropic XML 风格
    /<\/?(tool_call|arg_value|function_call|tool_use|invoke|parameters|arguments)\s*>/i,
    // 常见的不完整 JSON 工具调用碎片
    /\{\s*"(name|function|tool)":\s*"[a-z_]+".*[^}]$/s,
    // 明确的标签碎片（包括自闭合）
    /<\/?tool[_\-]?\w*\s*\/?>/i,
];

/**
 * 检测文本回复是否包含工具调用碎片
 */
export function detectMalformedToolCall(content: string): {
    detected: boolean;
    pattern: string;
    cleanContent: string;
} {
    for (const pattern of MALFORMED_TOOL_PATTERNS) {
        if (pattern.test(content)) {
            // 清理 XML 碎片
            const cleanContent = content
                .replace(/<\/?(tool_call|arg_value|function_call|tool_use|invoke|parameters|arguments)\s*>/gi, '')
                .replace(/<\/?tool[_\-]?\w*\s*\/?>/gi, '')
                .trim();

            return {
                detected: true,
                pattern: pattern.source,
                cleanContent,
            };
        }
    }

    return { detected: false, pattern: '', cleanContent: content };
}

// ==================== 工具名修复 ====================

/**
 * 尝试修复工具名
 * 返回修复后的工具名，修复失败返回 null
 */
export function repairToolName(
    toolName: string,
    availableTools: Map<string, any> | Set<string> | string[]
): { repaired: boolean; name: string } {
    // 1. 已经存在，不需要修复
    const names = availableTools instanceof Map
        ? Array.from(availableTools.keys())
        : availableTools instanceof Set
            ? Array.from(availableTools)
            : availableTools;

    if (names.includes(toolName)) {
        return { repaired: false, name: toolName };
    }

    // 1.5 call-like 名称修复（name(args) / name{...}）
    const callLikeMatch = toolName.match(/^([a-zA-Z_][\w-]*)\s*(?:\(|\{)/);
    if (callLikeMatch?.[1] && names.includes(callLikeMatch[1])) {
        cliLogger.info('TOOL_REPAIR', `Tool name call-like fix: "${toolName}" → "${callLikeMatch[1]}"`);
        return { repaired: true, name: callLikeMatch[1] };
    }

    // 2. 大小写修复
    const lower = toolName.toLowerCase();
    const match = names.find(n => n.toLowerCase() === lower);
    if (match) {
        cliLogger.info('TOOL_REPAIR', `Tool name case fix: "${toolName}" → "${match}"`);
        return { repaired: true, name: match };
    }

    // 3. 常见别名映射
    const ALIASES: Record<string, string> = {
        'bash': 'execute_shell',
        'shell': 'execute_shell',
        'exec': 'execute_shell',
        'run': 'execute_shell',
        'read': 'readfile',
        'read_file': 'readfile',
        'grep': 'search',
        'find': 'search_files',
        'write': 'write_file',
        'edit_file': 'edit',
        'cat': 'readfile',
        'ls': 'list_directory',
        'tree': 'show_tree',
    };

    const aliasMatch = ALIASES[lower];
    if (aliasMatch && names.includes(aliasMatch)) {
        cliLogger.info('TOOL_REPAIR', `Tool name alias fix: "${toolName}" → "${aliasMatch}"`);
        return { repaired: true, name: aliasMatch };
    }

    // 4. 无法修复
    return { repaired: false, name: toolName };
}

// ==================== 整体修复结果 ====================

export interface RepairResult {
    /** 是否检测到需要修复的问题 */
    detected: boolean;
    /** 修复类型 */
    type: 'none' | 'xml_fragment' | 'tool_name' | 'parse_error';
    /** 修复是否成功 */
    repaired: boolean;
    /** 原始内容 */
    original: string;
    /** 清理后的内容 */
    cleaned: string;
    /** 注入给模型的修复提示 */
    repairPrompt?: string;
}

/**
 * 生成修复提示（注入到对话历史，让模型自我修正）
 */
export function buildRepairPrompt(type: RepairResult['type'], content: string): string {
    switch (type) {
        case 'xml_fragment':
            return [
                '⚠️ 你上一次的回复包含了残缺的工具调用标签（如 </tool_call>、</arg_value>）。',
                '这通常是因为输出被截断。请：',
                '1. 使用标准的工具调用格式重新执行你想做的操作',
                '2. 不要在文本中手动输出 XML/JSON 标签',
                '3. 如果任务太长，先总结已完成的部分，再继续',
            ].join('\n');

        case 'tool_name':
            return `⚠️ 工具 "${content}" 不存在。请检查工具名是否正确，使用 select_tools 查看可用工具。`;

        case 'parse_error':
            return [
                '⚠️ 你上一次的工具调用参数格式不正确。请：',
                '1. 确保参数是有效的 JSON 对象格式',
                '2. 不要在 JSON 中包含注释或尾随逗号',
                `3. 原始输入: ${content.substring(0, 200)}`,
            ].join('\n');

        default:
            return '';
    }
}

// ==================== 统计 ====================

/**
 * 修复统计器（用于 session 级别追踪）
 */
export class RepairTracker {
    private repairs: Array<{
        iteration: number;
        type: RepairResult['type'];
        timestamp: number;
    }> = [];

    private maxRepairsPerType = 3; // 同类修复最多尝试次数

    record(iteration: number, type: RepairResult['type']): void {
        this.repairs.push({ iteration, type, timestamp: Date.now() });
    }

    /**
     * 检查是否应该放弃修复（同类型超过阈值）
     */
    shouldGiveUp(type: RepairResult['type']): boolean {
        const count = this.repairs.filter(r => r.type === type).length;
        return count >= this.maxRepairsPerType;
    }

    /**
     * 获取统计摘要
     */
    getSummary(): { total: number; byType: Record<string, number> } {
        const byType: Record<string, number> = {};
        for (const r of this.repairs) {
            byType[r.type] = (byType[r.type] || 0) + 1;
        }
        return { total: this.repairs.length, byType };
    }
}
