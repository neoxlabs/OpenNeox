import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TYPES, PilotDataHttpError, PilotDataUploader, MemoryQueueStore, builtinResolver, chainResolvers, makeResolver,
  metricKeyOf, normalizeRecord, parseTypeRef, ulid, ulidTime, validateTypeDef, ULID_RE,
  type PutResult, type RecordInput, type TypeDef,
} from './index.js';

const NOW = Date.UTC(2026, 9, 10, 8, 0, 0);
const rec = (o: Partial<RecordInput>): RecordInput => ({ id: ulid(NOW), type: 'note', occurred_at: NOW - 1000, data: { text: '午饭 35' }, ...o });

describe('ulid', () => {
  it('26 位、时间可反解、同毫秒单调', () => {
    const a = ulid(NOW), b = ulid(NOW), c = ulid(NOW + 1);
    expect(a).toMatch(ULID_RE);
    expect(ulidTime(a)).toBe(NOW);
    expect(a < b && b < c).toBe(true);
  });
});

describe('注册表', () => {
  it('内置类型 (首批 16 + 触发 + 八个房间的 7 种), 名字唯一且自身合法', () => {
    expect(BUILTIN_TYPES).toHaveLength(25);
    expect(new Set(BUILTIN_TYPES.map(t => t.name)).size).toBe(25);
    for (const t of BUILTIN_TYPES) expect(validateTypeDef(t, { resolveBuiltin: () => null })).toBeNull();
  });

  it('不带版本取最新; 带版本精确取', () => {
    const v2: TypeDef = { ...BUILTIN_TYPES[0], name: 'reading.book', version: 2, owner: 'plugin:x' };
    const r = makeResolver([{ ...v2, version: 1 }, v2]);
    expect(r('reading.book', null)?.version).toBe(2);
    expect(r('reading.book', 1)?.version).toBe(1);
    expect(parseTypeRef('health.weight@1')).toEqual({ name: 'health.weight', version: 1 });
    expect(parseTypeRef('Bad Name')).toBeNull();
  });

  it('插件不能占内置名', () => {
    const fake: TypeDef = { ...BUILTIN_TYPES[3], owner: 'plugin:x' };
    expect(validateTypeDef(fake)).toMatch(/内置/);
  });
});

describe('normalizeRecord', () => {
  it('note: 落库带版本, 自动标题, 默认 private', () => {
    const n = normalizeRecord(rec({}), { now: NOW });
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.record.type).toBe('note@1');
    expect(n.record.title).toBe('午饭 35');
    expect(n.record.privacy).toBe('private');
    expect(n.record.source).toBe('user');
  });

  it('隐私只能调高: 体重标 normal 仍是 sensitive; 敏感自动标题不带数值', () => {
    const n = normalizeRecord(rec({ type: 'health.weight', value: 72.3, data: {}, privacy: 'normal' }), { now: NOW });
    expect(n.ok && n.record.privacy).toBe('sensitive');
    expect(n.ok && n.record.unit).toBe('kg');
    expect(n.ok && n.record.title).not.toContain('72.3');
    /* 调用方自己写了带数值的标题也不收 */
    const t = normalizeRecord(rec({ type: 'health.weight', value: 72.3, data: {}, title: '体重 72.3 kg' }), { now: NOW });
    expect(t.ok && t.record.title).toBe('体重');
    /* 不敏感的照收 */
    const s = normalizeRecord(rec({ type: 'health.steps', value: 3000, title: '晨跑后' }), { now: NOW });
    expect(s.ok && s.record.title).toBe('晨跑后');
  });

  it('metric 缺 value 拒; valueFrom 从字段取', () => {
    expect(normalizeRecord(rec({ type: 'health.steps', data: {} }), { now: NOW })).toMatchObject({ ok: false });
    const m = normalizeRecord(rec({ type: 'mood', data: { score: 4 } }), { now: NOW });
    expect(m.ok && m.record.value).toBe(4);
  });

  it('interval: 要 ended_at, 时长自动算成分钟', () => {
    expect(normalizeRecord(rec({ type: 'health.sleep', data: {} }), { now: NOW }).ok).toBe(false);
    const s = normalizeRecord(rec({ type: 'health.sleep', data: {}, occurred_at: NOW - 8 * 3600_000, ended_at: NOW - 30 * 60_000 }), { now: NOW });
    expect(s.ok && s.record.value).toBe(450);
  });

  it('币种做单位并细分指标', () => {
    const e = normalizeRecord(rec({ type: 'finance.expense', value: 35, data: { currency: 'cny', category: '午饭' } }), { now: NOW });
    expect(e.ok && e.record.unit).toBe('CNY');
    if (e.ok) expect(metricKeyOf(e.def, e.record)).toBe('finance.expense:CNY');
  });

  it('坏输入逐项报错', () => {
    const bad: Array<[Partial<RecordInput>, RegExp]> = [
      [{ id: 'x' }, /ULID/],
      [{ type: 'nope.never' }, /未知类型/],
      [{ occurred_at: NOW + 3 * 86_400_000 }, /occurred_at/],
      [{ data: {} }, /text 必填/],
      [{ type: 'mood', data: { score: 9 } }, /不能大于 5/],
      [{ tz: 'Mars/Base' }, /时区/],
      [{ confidence: 0 }, /confidence/],
      [{ tags: Array.from({ length: 40 }, (_, i) => `t${i}`) }, /标签最多/],
    ];
    for (const [o, re] of bad) {
      const n = normalizeRecord(rec(o), { now: NOW });
      expect(n.ok).toBe(false);
      if (!n.ok) expect(n.error).toMatch(re);
    }
  });

  it('自定义类型通过链式解析器可用', () => {
    const book: TypeDef = { name: 'reading.book', version: 1, domain: 'learning', privacy: 'normal', kind: 'point', owner: 'plugin:books', label: { zh: '读书', en: 'Book' }, fields: { title: { type: 'string', required: true } }, title: '读《{title}》' };
    const r = chainResolvers(builtinResolver, makeResolver([book]));
    const n = normalizeRecord(rec({ type: 'reading.book', data: { title: '三体' } }), { now: NOW, resolve: r });
    expect(n.ok && n.record.title).toBe('读《三体》');
  });
});

describe('PilotDataUploader', () => {
  it('攒批发送, 逐条结果出队, invalid 回调', async () => {
    const sent: RecordInput[][] = [];
    const invalid: string[] = [];
    const up = new PilotDataUploader({
      source: 'device:test', flushMs: 60_000, maxBatch: 2,
      client: { putBatch: async (rs: unknown[]) => { sent.push(rs as RecordInput[]); return { results: (rs as RecordInput[]).map((r, i): PutResult => ({ id: r.id, status: i === 0 && sent.length === 1 ? 'invalid' : 'ok' })) }; } },
      onInvalid: r => invalid.push(r.id),
    });
    const ids = await up.log([{ type: 'note', data: { text: 'a' } }, { type: 'note', data: { text: 'b' } }, { type: 'note', data: { text: 'c' } }]);
    await up.flush();
    expect(sent.map(b => b.length)).toEqual([2, 1]);
    expect(invalid).toEqual([ids[0]]);
    expect(await up.store.size()).toBe(0);
    expect(sent[0][0].source).toBe('device:test');
    await up.close();
  });

  it('网络错留在队列, 本地校验不过当场抛', async () => {
    const store = new MemoryQueueStore();
    const up = new PilotDataUploader({ source: 'device:test', store, flushMs: 60_000, client: { putBatch: async () => { throw new PilotDataHttpError(0, 'offline', true); } } });
    await expect(up.log({ type: 'mood', data: { score: 7 } })).rejects.toThrow(/不能大于/);
    await up.log({ type: 'note', data: { text: 'x' } });
    await up.flush();
    expect(await store.size()).toBe(1);
    (up as unknown as { stopped: boolean }).stopped = true;
  });

  it('整批 4xx 拆单条定位坏的', async () => {
    const up = new PilotDataUploader({
      source: 'device:test', flushMs: 60_000,
      client: { putBatch: async (rs: unknown[]) => {
        const list = rs as RecordInput[];
        if (list.length > 1 || (list[0].data as { text: string }).text === 'bad') throw new PilotDataHttpError(413, 'too large', false);
        return { results: [{ id: list[0].id, status: 'ok' as const }] };
      } },
    });
    const bad: string[] = [];
    (up as unknown as { o: { onInvalid: (r: PutResult) => void } }).o.onInvalid = r => bad.push(r.id);
    const ids = await up.log([{ type: 'note', data: { text: 'ok' } }, { type: 'note', data: { text: 'bad' } }]);
    await up.flush();
    expect(bad).toEqual([ids[1]]);
    expect(await up.store.size()).toBe(0);
    await up.close();
  });
});
