/**
 * SessionState Unit Tests — 会话状态追踪
 *
 * 测试核心防护能力：
 * 1. 文件写入追踪
 * 2. 文件读取缓存 (Claude Code 风格 edit 验证)
 * 3. 重复编辑检测（幻觉编辑防护）
 * 4. old_string 缓存验证
 * 5. 工具调用历史
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    createSessionState,
    recordFileWrite,
    recordFileEdit,
    recordFileRead,
    getFileReadCache,
    validateOldStringAgainstCache,
    checkDuplicateEdit,
    recordToolCall,
    isFileWritten,
    getWrittenFileInfo,
    getEditHistory,
    getSessionState,
    resetGlobalSessionState,
} from '@neoxlabs/kernel/core/sessionState.js';

describe('SessionState', () => {
    beforeEach(() => {
        resetGlobalSessionState();
    });

    // ========================================================================
    // 1. 文件写入追踪
    // ========================================================================
    describe('File write tracking', () => {
        it('should track file writes', () => {
            recordFileWrite(undefined, '/test.ts', 'abc123', 50);
            expect(isFileWritten(undefined, '/test.ts')).toBe(true);
            expect(isFileWritten(undefined, '/other.ts')).toBe(false);
        });

        it('should store file info', () => {
            recordFileWrite(undefined, '/test.ts', 'abc123', 50);
            const info = getWrittenFileInfo(undefined, '/test.ts');
            expect(info).toBeTruthy();
            expect(info!.checksum).toBe('abc123');
            expect(info!.lines).toBe(50);
        });
    });

    // ========================================================================
    // 2. 文件读取缓存 (Claude Code 风格)
    // ========================================================================
    describe('File read cache', () => {
        it('should cache file read content', () => {
            const content = 'function hello() {\n  console.log("hello");\n}';
            recordFileRead(undefined, '/test.ts', content);

            const cache = getFileReadCache(undefined, '/test.ts');
            expect(cache).toBeTruthy();
            expect(cache!.content).toBe(content);
        });

        it('should update cache on re-read', () => {
            recordFileRead(undefined, '/test.ts', 'old content');
            recordFileRead(undefined, '/test.ts', 'new content');

            const cache = getFileReadCache(undefined, '/test.ts');
            expect(cache!.content).toBe('new content');
        });
    });

    // ========================================================================
    // 3. old_string 缓存验证 (编辑防护核心)
    // ========================================================================
    describe('old_string validation against read cache', () => {
        it('should validate old_string exists in cached content', () => {
            recordFileRead(undefined, '/test.ts', 'function hello() {\n  return "hi";\n}');

            const result = validateOldStringAgainstCache(undefined, '/test.ts', 'return "hi"');
            expect(result.isValid).toBe(true);
            expect(result.hasCache).toBe(true);
        });

        it('should reject old_string not in cached content', () => {
            recordFileRead(undefined, '/test.ts', 'function hello() {\n  return "hi";\n}');

            const result = validateOldStringAgainstCache(undefined, '/test.ts', 'this does not exist');
            expect(result.isValid).toBe(false);
            expect(result.reason).toBeTruthy();
        });

        it('should return hasCache=false when no cache exists', () => {
            const result = validateOldStringAgainstCache(undefined, '/uncached.ts', 'anything');
            expect(result.hasCache).toBe(false);
        });
    });

    // ========================================================================
    // 4. 重复编辑检测（幻觉编辑）
    // ========================================================================
    describe('Duplicate edit detection', () => {
        it('should detect exact duplicate edit', () => {
            recordFileEdit(undefined, '/test.ts', 'old code', 'new code', true);

            const result = checkDuplicateEdit(undefined, '/test.ts', 'old code', 'new code');
            expect(result.isDuplicate).toBe(true);
            expect(result.reason).toBeTruthy();
        });

        it('should not flag different edits', () => {
            recordFileEdit(undefined, '/test.ts', 'old code', 'new code', true);

            const result = checkDuplicateEdit(undefined, '/test.ts', 'different old', 'different new');
            expect(result.isDuplicate).toBe(false);
        });
    });

    // ========================================================================
    // 5. 工具调用历史
    // ========================================================================
    describe('Tool call history', () => {
        it('should record tool calls', () => {
            recordToolCall(undefined, 'readfile', { file_path: '/test.ts' }, true);
            recordToolCall(undefined, 'edit_file', { file_path: '/test.ts' }, true);

            const state = getSessionState(undefined);
            expect(state.toolCallHistory.length).toBe(2);
            expect(state.toolCallHistory[0].name).toBe('readfile');
            expect(state.toolCallHistory[1].name).toBe('edit_file');
        });
    });

    // ========================================================================
    // 6. 编辑历史
    // ========================================================================
    describe('Edit history', () => {
        it('should track edit history per file', () => {
            recordFileEdit(undefined, '/test.ts', 'old1', 'new1', true);
            recordFileEdit(undefined, '/test.ts', 'old2', 'new2', true);
            recordFileEdit(undefined, '/other.ts', 'old3', 'new3', true);

            const history = getEditHistory(undefined, '/test.ts');
            expect(history.length).toBe(2);
            expect(history[0].oldString).toBe('old1');
            expect(history[1].oldString).toBe('old2');
        });
    });

    // ========================================================================
    // 7. 状态隔离
    // ========================================================================
    describe('State isolation', () => {
        it('should reset global state cleanly', () => {
            recordFileWrite(undefined, '/test.ts', 'abc', 10);
            resetGlobalSessionState();

            expect(isFileWritten(undefined, '/test.ts')).toBe(false);
        });
    });
});
