
import { describe, it, expect } from 'vitest';
import {
  applyEffortPick, effectiveEffort, effectiveEffortMap, emptyEffortPrefs,
  parseEffortPrefs, resolveSendableEffort, serializeEffortPrefs, withModeDefaultEffort, EFFORT_TURN_ON,
  EFFORT_STANDARD,
} from '../effortPrefs';

const M = 'deepseek-v4-flash';
const N = 'claude-opus-5';

describe('applyEffortPick · 基本写入', () => {
  it('选一档 → 该模型生效这一档', () => {
    const p = applyEffortPick(emptyEffortPrefs(), M, 'max');
    expect(effectiveEffort(p, M)).toBe('max');
  });

  it('改档 → 覆盖前一档', () => {
    let p = applyEffortPick(emptyEffortPrefs(), M, 'max');
    p = applyEffortPick(p, M, 'low');
    expect(effectiveEffort(p, M)).toBe('low');
  });

  it('每个模型各记各的, 互不干扰', () => {
    let p = applyEffortPick(emptyEffortPrefs(), M, 'max');
    p = applyEffortPick(p, N, 'low');
    expect(effectiveEffort(p, M)).toBe('max');
    expect(effectiveEffort(p, N)).toBe('low');
  });

  it("'standard' 是删除而不是写入 (下游按 undefined 处理)", () => {
    let p = applyEffortPick(emptyEffortPrefs(), M, 'max');
    p = applyEffortPick(p, M, 'standard');
    expect(effectiveEffort(p, M)).toBeUndefined();
    expect(Object.keys(p.levels)).not.toContain(M);
  });

  it('纯函数: 不改入参', () => {
    const before = emptyEffortPrefs();
    const snapshot = JSON.stringify(before);
    applyEffortPick(before, M, 'max');
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('applyEffortPick · 关思考不许吃掉用户选的档 (用户报的那个 bug)', () => {
  it('选 Max → 关思考 → 再开, 必须回到 Max 而不是默认档', () => {
    let p = applyEffortPick(emptyEffortPrefs(), M, 'max');
    p = applyEffortPick(p, M, 'off');
    expect(effectiveEffort(p, M), '关着的时候生效档是 off').toBe('off');
    expect(p.levels[M], '但用户选的档必须还在').toBe('max');
    p = applyEffortPick(p, M, EFFORT_TURN_ON);
    expect(effectiveEffort(p, M)).toBe('max');
  });

  it('反复开关不掉档', () => {
    let p = applyEffortPick(emptyEffortPrefs(), M, 'low');
    for (let i = 0; i < 5; i++) {
      p = applyEffortPick(p, M, 'off');
      p = applyEffortPick(p, M, EFFORT_TURN_ON);
    }
    expect(effectiveEffort(p, M)).toBe('low');
  });

  it('关着的时候直接点某一档 = 开思考并选这档', () => {
    let p = applyEffortPick(emptyEffortPrefs(), M, 'off');
    p = applyEffortPick(p, M, 'max');
    expect(effectiveEffort(p, M)).toBe('max');
    expect(p.thinkingOff).not.toContain(M);
  });

  it('开思考的哨兵不写入 levels —— 它是动作不是档位', () => {
    const p = applyEffortPick(emptyEffortPrefs(), M, EFFORT_TURN_ON);
    expect(p.levels[M]).toBeUndefined();
    expect(effectiveEffort(p, M)).toBeUndefined();
  });

  /* glm-5.2 / kimi-k2-6 / doubao-pro / qwen-3-max 的 effort_map 里 `on` 是**真实档位**。
   * 第一版拿 'on' 当"开思考"哨兵, 点那一行会被当动作吃掉, 档位存不进去。 */
  it("'on' 是真实档位 (glm/kimi/doubao/qwen), 必须能正常存下来", () => {
    const p = applyEffortPick(emptyEffortPrefs(), 'glm-5.2', 'on');
    expect(p.levels['glm-5.2']).toBe('on');
    expect(effectiveEffort(p, 'glm-5.2')).toBe('on');
  });

  it("选了 'on' 档再关思考再开, 仍回到 'on'", () => {
    let p = applyEffortPick(emptyEffortPrefs(), 'glm-5.2', 'on');
    p = applyEffortPick(p, 'glm-5.2', 'off');
    p = applyEffortPick(p, 'glm-5.2', EFFORT_TURN_ON);
    expect(effectiveEffort(p, 'glm-5.2')).toBe('on');
  });

  it('哨兵值不可能与任何 yaml 档位撞名', () => {
    /* schemas/models/*.yaml 里出现过的全部键 */
    const 全部真实档位 = ['off','on','auto','fast','minimal','low','standard','medium','deep','high','xhigh','max','ultra'];
    expect(全部真实档位).not.toContain(EFFORT_TURN_ON);
  });

  it('A 关思考不影响 B', () => {
    let p = applyEffortPick(emptyEffortPrefs(), M, 'max');
    p = applyEffortPick(p, N, 'low');
    p = applyEffortPick(p, M, 'off');
    expect(effectiveEffort(p, M)).toBe('off');
    expect(effectiveEffort(p, N)).toBe('low');
  });
});

describe('effectiveEffortMap · 摊平给 UI', () => {
  it('关思考的呈现为 off, 其余呈现所选档', () => {
    let p = applyEffortPick(emptyEffortPrefs(), M, 'max');
    p = applyEffortPick(p, N, 'low');
    p = applyEffortPick(p, M, 'off');
    const m = effectiveEffortMap(p);
    expect(m.get(M)).toBe('off');
    expect(m.get(N)).toBe('low');
  });

  it('没有记录的模型不出现在 map 里', () => {
    expect(effectiveEffortMap(emptyEffortPrefs()).size).toBe(0);
  });
});

describe('持久化 · 存回来要一模一样, 脏数据不许抛', () => {
  it('往返一致 (含关思考状态)', () => {
    let p = applyEffortPick(emptyEffortPrefs(), M, 'max');
    p = applyEffortPick(p, N, 'low');
    p = applyEffortPick(p, N, 'off');
    const back = parseEffortPrefs(serializeEffortPrefs(p));
    expect(back).toEqual(p);
    expect(effectiveEffort(back, M)).toBe('max');
    expect(effectiveEffort(back, N)).toBe('off');
    /* 重启后开回思考, 仍要拿回 low */
    expect(effectiveEffort(applyEffortPick(back, N, EFFORT_TURN_ON), N)).toBe('low');
  });

  /* 这是启动关键路径上的读取 —— 抛一下整个 runtime bridge 就起不来 */
  it.each([
    ['undefined', undefined], ['null', null], ['空串', ''], ['坏 JSON', '{oops'],
    ['JSON 但不是对象', '"hello"'], ['数字', '42'], ['数组', '[1,2,3]'],
    ['缺字段', '{}'], ['字段类型全错', '{"levels":123,"thinkingOff":"x"}'],
    ['levels 里混非法值', '{"levels":{"a":1,"":"low","b":"max"},"thinkingOff":[null,"c",7]}'],
  ])('脏数据 %s → 退化成空偏好且不抛', (_名, raw) => {
    expect(() => parseEffortPrefs(raw)).not.toThrow();
    const p = parseEffortPrefs(raw);
    expect(Array.isArray(p.thinkingOff)).toBe(true);
    expect(typeof p.levels).toBe('object');
  });

  it('脏数据里的合法项要留下, 非法项要丢掉', () => {
    const p = parseEffortPrefs('{"levels":{"a":1,"":"low","b":"max"},"thinkingOff":[null,"c",7]}');
    expect(p.levels).toEqual({ b: 'max' });
    expect(p.thinkingOff).toEqual(['c']);
  });

  it("读回时把 'standard' 滤掉 (等价于没记录)", () => {
    expect(parseEffortPrefs('{"levels":{"a":"standard","b":"low"}}').levels).toEqual({ b: 'low' });
  });
});

describe('resolveSendableEffort · 界面显示什么就发什么', () => {
  it('模型支持这一档 → 原样发', () => {
    expect(resolveSendableEffort('max', ['off', 'low', 'high', 'max'])).toBe('max');
  });

  it('模型不支持这一档 → 不发 (UI 那边也是回落默认档, 两边一致)', () => {
    expect(resolveSendableEffort('max', ['off', 'low', 'high'])).toBeUndefined();
  });

  it('还不知道支持哪些档 (schema 未取回) → 保持原值, 不擅自降级', () => {
    expect(resolveSendableEffort('max', undefined)).toBe('max');
  });

  it("没选过 / 'standard' → 不发字段", () => {
    expect(resolveSendableEffort(undefined, ['low'])).toBeUndefined();
    expect(resolveSendableEffort('standard', ['low'])).toBeUndefined();
  });

  it("'off' 是真实档位, 模型支持就要发出去", () => {
    expect(resolveSendableEffort('off', ['off', 'low', 'high'])).toBe('off');
  });

  it('支持列表为空数组 = 明确知道一档都没有 → 不发', () => {
    expect(resolveSendableEffort('max', [])).toBeUndefined();
  });
});

describe('withModeDefaultEffort · Work 没选过档默认 low', () => {
  const levels = ['off', 'low', 'high', 'max'];
  it('Work + 没选过 + 有 low 档 → low', () => {
    expect(withModeDefaultEffort(EFFORT_STANDARD, 'work', levels)).toBe('low');
  });
  it('用户选过档照用户的', () => {
    expect(withModeDefaultEffort('max', 'work', levels)).toBe('max');
  });
  it('其他模式 / 没有 low 档 / 档位未知 → 不动', () => {
    expect(withModeDefaultEffort(EFFORT_STANDARD, 'code', levels)).toBe(EFFORT_STANDARD);
    expect(withModeDefaultEffort(EFFORT_STANDARD, 'work', ['high'])).toBe(EFFORT_STANDARD);
    expect(withModeDefaultEffort(EFFORT_STANDARD, 'work', undefined)).toBe(EFFORT_STANDARD);
  });
});
