import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const STORE = strip(readFileSync(resolve(HERE, '../../state/timelineStore.tsx'), 'utf8'));
const BRIDGE = strip(readFileSync(resolve(HERE, '../app/NeoxRuntimeBridge.tsx'), 'utf8'));

describe('#16 多窗口失效标记不许被缓存短路吞掉', () => {
  it('直播短路必须先确认这个会话真有 sub- 行', () => {
    /* 光看"有非 sub- 条目"等于对每个主会话恒真 —— 那个短路就成了无条件的。 */
    expect(STORE).toMatch(/const hasSubRows\s*=/);
    expect(STORE).toMatch(/const hasLiveStreamEntries\s*=\s*hasSubRows\s*&&/);
  });

  it('externallyDirty 这个信号还在被读', () => {
    expect(STORE).toMatch(/externallyDirtySessions\.has\(sessionId\)/);
  });
});

describe('#18 种子快照不许把已删条目写回', () => {
  it('oldTimeline 落库前过墓碑', () => {
    const i = STORE.indexOf('seeding oldTimeline into SQLite failed');
    expect(i, '找不到种子快照落库那段').toBeGreaterThan(0);
    const block = STORE.slice(Math.max(0, i - 900), i);
    expect(block).toMatch(/dropTombstoned\(sessionId, oldTimeline\)/);
  });
});

describe('#19 重新生成不叠气泡', () => {
  it('重试分支会删掉上一次尝试的 assistant_message', () => {
    const i = BRIDGE.indexOf('if (isRetry && !isContinue) {');
    expect(i).toBeGreaterThan(0);
    const block = BRIDGE.slice(i, i + 1600);
    expect(block).toMatch(/type === 'assistant_message'/);
    expect(block).toMatch(/deleteTimelineEntry/);
  });

  it('只删已完成的, 不碰 pending —— 那是正在跑的这一轮自己', () => {
    const i = BRIDGE.indexOf('if (isRetry && !isContinue) {');
    const block = BRIDGE.slice(i, i + 1600);
    expect(block).toMatch(/!e\.pending/);
  });

  /* 工具卡记录的是**已经发生的事实** (上一次尝试可能真改过文件), 删掉等于骗人 */
  it('不许连工具卡一起删', () => {
    const i = BRIDGE.indexOf('if (isRetry && !isContinue) {');
    const block = BRIDGE.slice(i, i + 1600);
    expect(block).not.toMatch(/type === 'tool_call'|type === 'tool_result'/);
  });
});
