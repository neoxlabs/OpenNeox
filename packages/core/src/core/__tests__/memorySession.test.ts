/**
 * MemorySession Unit Tests — 多轮对话 & 会话记忆
 *
 * 测试 Session 的核心能力：
 * 1. 多轮消息存取（add/getItems）
 * 2. 消息顺序保证
 * 3. Checkpoint & Rollback（回滚到历史点）
 * 4. maxItems 自动清理（内存压力）
 * 5. popItem/popItems（撤销最近操作）
 * 6. clearSession（完全重置）
 * 7. Timeline 操作
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemorySession } from '../../memory/memory-session.js';

describe('MemorySession', () => {
    let session: MemorySession;

    beforeEach(() => {
        session = new MemorySession({
            sessionId: 'test-session-001',
            agentName: 'test-agent',
            model: 'gpt-4o',
        });
    });

    // ========================================================================
    // 1. 基本消息存取
    // ========================================================================
    describe('Basic message operations', () => {
        it('should create session with meta item', async () => {
            const items = await session.getItems();
            expect(items.length).toBe(1); // meta item
            expect(items[0].type).toBe('meta');
        });

        it('should add and retrieve messages', async () => {
            await session.addItems([
                { type: 'message', data: { role: 'user', content: '帮我写个排序函数' } },
                { type: 'message', data: { role: 'assistant', content: '好的，我来帮你实现' } },
            ]);

            const items = await session.getItems();
            expect(items.length).toBe(3); // meta + 2 messages
            expect(items[1].type).toBe('message');
            expect(items[2].type).toBe('message');
        });

        it('should return messages via getMessages()', async () => {
            await session.addItems([
                { type: 'message', data: { role: 'user', content: '你好' } },
                { type: 'message', data: { role: 'assistant', content: '你好！' } },
            ]);

            const messages = await session.getMessages();
            expect(messages.length).toBe(2);
            expect(messages[0].role).toBe('user');
            expect(messages[1].role).toBe('assistant');
        });

        it('should support limit parameter in getItems()', async () => {
            await session.addItems([
                { type: 'message', data: { role: 'user', content: 'msg1' } },
                { type: 'message', data: { role: 'user', content: 'msg2' } },
                { type: 'message', data: { role: 'user', content: 'msg3' } },
            ]);

            const last2 = await session.getItems(2);
            expect(last2.length).toBe(2);
            // 应该返回最近的 2 条
            expect((last2[0] as any).data.content).toBe('msg2');
            expect((last2[1] as any).data.content).toBe('msg3');
        });
    });

    // ========================================================================
    // 2. 多轮对话保序
    // ========================================================================
    describe('Multi-turn conversation ordering', () => {
        it('should preserve message order across multiple turns', async () => {
            // 模拟多轮对话
            await session.addItems([
                { type: 'message', data: { role: 'user', content: 'Turn 1: 帮我创建一个 React 组件' } },
            ]);
            await session.addItems([
                { type: 'message', data: { role: 'assistant', content: 'Turn 1: 好的，先创建文件' } },
            ]);
            await session.addItems([
                { type: 'message', data: { role: 'user', content: 'Turn 2: 再添加样式' } },
            ]);
            await session.addItems([
                { type: 'message', data: { role: 'assistant', content: 'Turn 2: 已添加 CSS' } },
            ]);

            const messages = await session.getMessages();
            expect(messages.length).toBe(4);
            expect(messages[0].content).toContain('Turn 1');
            expect(messages[1].content).toContain('Turn 1');
            expect(messages[2].content).toContain('Turn 2');
            expect(messages[3].content).toContain('Turn 2');
            // 验证角色交替
            expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
        });
    });

    // ========================================================================
    // 3. Checkpoint & Rollback
    // ========================================================================
    describe('Checkpoint & Rollback', () => {
        it('should create and list checkpoints', async () => {
            await session.addItems([
                { type: 'message', data: { role: 'user', content: 'msg1' } },
            ]);

            const cpId = await session.createCheckpoint('after-msg1', 'First message added');

            expect(cpId).toBeTruthy();
            expect(cpId).toMatch(/^cp_/);

            const checkpoints = await session.getCheckpoints();
            expect(checkpoints.length).toBe(1);
            expect(checkpoints[0].id).toBe(cpId);
            expect(checkpoints[0].name).toBe('after-msg1');
        });

        it('should rollback to checkpoint (remove subsequent items)', async () => {
            await session.addItems([
                { type: 'message', data: { role: 'user', content: 'msg1' } },
            ]);

            const cpId = await session.createCheckpoint('cp1');

            // 在 checkpoint 后添加更多消息
            await session.addItems([
                { type: 'message', data: { role: 'assistant', content: 'msg2' } },
                { type: 'message', data: { role: 'user', content: 'msg3' } },
            ]);

            const countBefore = await session.getItemCount();
            // meta(1) + msg1(1) + cp(1) + msg2(1) + msg3(1) = 5
            expect(countBefore).toBe(5);

            // 回滚到 checkpoint
            const removed = await session.rollbackToCheckpoint(cpId);
            expect(removed).toBe(2); // msg2 和 msg3 被移除

            const countAfter = await session.getItemCount();
            expect(countAfter).toBe(3); // meta + msg1 + checkpoint

            // 消息列表应该只有 msg1
            const messages = await session.getMessages();
            expect(messages.length).toBe(1);
            expect(messages[0].content).toBe('msg1');
        });

        it('should throw on invalid checkpoint ID', async () => {
            await expect(
                session.rollbackToCheckpoint('cp_nonexistent')
            ).rejects.toThrow('Checkpoint not found');
        });
    });

    // ========================================================================
    // 4. maxItems 内存压力管理
    // ========================================================================
    describe('maxItems — memory pressure', () => {
        it('should auto-evict old items when exceeding maxItems', async () => {
            const boundedSession = new MemorySession({
                sessionId: 'bounded-session',
                maxItems: 5,
            });

            // meta(1) + 6 messages = 7, 超过 maxItems(5)
            for (let i = 0; i < 6; i++) {
                await boundedSession.addItems([
                    { type: 'message', data: { role: 'user', content: `msg${i}` } },
                ]);
            }

            const count = await boundedSession.getItemCount();
            expect(count).toBeLessThanOrEqual(5);

            // meta 应该始终保留
            const items = await boundedSession.getItems();
            const metaItems = items.filter(i => i.type === 'meta');
            expect(metaItems.length).toBe(1);
        });

        it('should keep checkpoints when evicting', async () => {
            const boundedSession = new MemorySession({
                sessionId: 'bounded-cp',
                maxItems: 5,
            });

            await boundedSession.addItems([
                { type: 'message', data: { role: 'user', content: 'msg1' } },
            ]);
            await boundedSession.createCheckpoint('cp1');

            // 添加大量消息触发清理
            for (let i = 0; i < 5; i++) {
                await boundedSession.addItems([
                    { type: 'message', data: { role: 'user', content: `overflow_${i}` } },
                ]);
            }

            // checkpoint 应该被保留
            const checkpoints = await boundedSession.getCheckpoints();
            expect(checkpoints.length).toBe(1);
        });
    });

    // ========================================================================
    // 5. popItem / popItems
    // ========================================================================
    describe('Pop operations', () => {
        it('should pop last non-meta item', async () => {
            await session.addItems([
                { type: 'message', data: { role: 'user', content: 'to-pop' } },
            ]);

            const popped = await session.popItem();
            expect(popped).toBeTruthy();
            expect(popped!.type).toBe('message');
            expect((popped as any).data.content).toBe('to-pop');

            // 只剩 meta
            const count = await session.getItemCount();
            expect(count).toBe(1);
        });

        it('should not pop meta items', async () => {
            // 只有 meta，pop 应该返回 null
            const popped = await session.popItem();
            expect(popped).toBeNull();
        });

        it('should pop multiple items in order', async () => {
            await session.addItems([
                { type: 'message', data: { role: 'user', content: 'a' } },
                { type: 'message', data: { role: 'assistant', content: 'b' } },
                { type: 'message', data: { role: 'user', content: 'c' } },
            ]);

            const popped = await session.popItems(2);
            expect(popped.length).toBe(2);
            // 应该保持原始顺序
            expect((popped[0] as any).data.content).toBe('b');
            expect((popped[1] as any).data.content).toBe('c');
        });
    });

    // ========================================================================
    // 6. Clear & Reset
    // ========================================================================
    describe('Clear session', () => {
        it('should clear all state', async () => {
            await session.addItems([
                { type: 'message', data: { role: 'user', content: 'test' } },
            ]);
            await session.createCheckpoint('cp');

            await session.clearSession();

            expect(await session.getItemCount()).toBe(0);
            expect(await session.getMeta()).toBeNull();
            expect(await session.getMessages()).toEqual([]);
        });
    });

    // ========================================================================
    // 7. Timeline 操作
    // ========================================================================
    describe('Timeline', () => {
        it('should return timeline with timestamps', async () => {
            await session.addItems([
                { type: 'message', data: { role: 'user', content: 'test' } },
            ]);

            const timeline = await session.getTimeline();
            expect(timeline.length).toBe(2); // meta + message
            expect(timeline[0].timestamp).toBeTruthy();
            expect(timeline[0].seq).toBe(0);
            expect(timeline[1].seq).toBe(1);
        });

        it('should replace timeline', async () => {
            await session.addItems([
                { type: 'message', data: { role: 'user', content: 'original' } },
            ]);

            const newTimeline = [
                { item: { type: 'meta' as const, data: {} }, timestamp: Date.now(), seq: 0 },
                { item: { type: 'message' as const, data: { role: 'user' as const, content: 'replaced' } }, timestamp: Date.now(), seq: 1 },
            ];

            await session.replaceTimeline(newTimeline);

            const messages = await session.getMessages();
            expect(messages.length).toBe(1);
            expect(messages[0].content).toBe('replaced');
        });
    });

    // ========================================================================
    // 8. Static create
    // ========================================================================
    describe('Static create', () => {
        it('should generate unique session ID', () => {
            const s1 = MemorySession.create({ agentName: 'a' });
            const s2 = MemorySession.create({ agentName: 'b' });
            expect(s1.sessionId).not.toBe(s2.sessionId);
        });
    });
});
