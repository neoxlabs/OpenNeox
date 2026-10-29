/**
 * 每个模型的推理强度偏好 —— 纯数据 + 纯函数, 便于单测。
 *
 * 【为什么要拆成 levels / thinkingOff 两份, 而不是一个 Map<modelId, level>】
 * 旧实现把 'off' 直接写进同一个 Map, 于是**关思考等于把用户选的档覆盖掉**:
 *   选 Max → 关思考 (写 'off', Max 没了) → 再开 → 只能回默认档 High。
 * 用户选的档和"这个模型此刻关不关思考"是两个正交的事实, 混在一格里必然丢信息。
 * 拆开之后"关了再开要回到原来那档"由**结构本身**保证, 不需要额外记忆逻辑。
 *
 * 【为什么 'standard' 是删除而不是写入】
 * 'standard' 是"没有特别指定"的意思, 下游按 undefined 处理 (不发 effortLevel 字段)。
 * 存下来反而要在每个读取点再判一次, 所以在写入侧就归一化掉。
 */

/** 未特别指定的哨兵 —— 存进去没有意义, 一律按"删除该模型的记录"处理 */
export const EFFORT_STANDARD = 'standard';
/** 关闭思考。它是 effort_map 里的真实档位, 会原样发给下游 */
export const EFFORT_OFF = 'off';
export const EFFORT_TURN_ON = '__thinking_on__';

export interface EffortPrefs {
  /** modelId → 用户选的**非-off**档位 */
  levels: Record<string, string>;
  /** 此刻关闭了思考的 modelId —— 与 levels 正交, 关思考不动 levels */
  thinkingOff: string[];
}

export function emptyEffortPrefs(): EffortPrefs {
  return { levels: {}, thinkingOff: [] };
}

/**
 * 用户在菜单里点了某一档 (含"思考"开关写来的 'off')。返回新对象, 不改入参。
 *
 *   点 'off'        → 只标记关思考, **保留** levels 里那一档
 *   点其它档        → 写入该档并解除关思考 (关着的时候点档位 = 开思考并选这档)
 *   点 'standard'   → 删除该模型的记录, 同时解除关思考
 */
export function applyEffortPick(prefs: EffortPrefs, modelId: string, level: string): EffortPrefs {
  const levels = { ...prefs.levels };
  const off = new Set(prefs.thinkingOff);
  if (level === EFFORT_OFF) {
    off.add(modelId);
  } else if (level === EFFORT_TURN_ON) {
    off.delete(modelId);
  } else {
    off.delete(modelId);
    if (level === EFFORT_STANDARD) delete levels[modelId];
    else levels[modelId] = level;
  }
  return { levels, thinkingOff: [...off].sort() };
}

/** 某个模型此刻**实际生效**的档位; 没有记录返回 undefined (= standard) */
export function effectiveEffort(prefs: EffortPrefs, modelId: string): string | undefined {
  if (prefs.thinkingOff.includes(modelId)) return EFFORT_OFF;
  return prefs.levels[modelId];
}

/** 摊平成 UI 直接读的 Map —— 关思考的模型呈现为 'off', 其余呈现所选档 */
export function effectiveEffortMap(prefs: EffortPrefs): Map<string, string> {
  const m = new Map(Object.entries(prefs.levels));
  for (const id of prefs.thinkingOff) m.set(id, EFFORT_OFF);
  return m;
}

export function serializeEffortPrefs(prefs: EffortPrefs): string {
  return JSON.stringify(prefs);
}

/**
 * 从持久化里读回 —— **任何脏数据都只能退化成空偏好, 不许抛**。
 * 这是启动路径上的读取, 抛一下整个 runtime bridge 就起不来了。
 */
export function parseEffortPrefs(raw: unknown): EffortPrefs {
  if (typeof raw !== 'string' || !raw) return emptyEffortPrefs();
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return emptyEffortPrefs(); }
  if (!obj || typeof obj !== 'object') return emptyEffortPrefs();
  const src = obj as Partial<EffortPrefs>;
  const levels: Record<string, string> = {};
  if (src.levels && typeof src.levels === 'object') {
    for (const [k, v] of Object.entries(src.levels)) {
      if (typeof k === 'string' && k && typeof v === 'string' && v && v !== EFFORT_STANDARD) levels[k] = v;
    }
  }
  const thinkingOff = Array.isArray(src.thinkingOff)
    ? [...new Set(src.thinkingOff.filter((x): x is string => typeof x === 'string' && !!x))].sort()
    : [];
  return { levels, thinkingOff };
}

/**
 * 真正发给下游的档位 —— 保证"界面显示什么就发什么"。
 *
 * 【为什么需要它】
 * 合法性过滤原先**只写在 UI 里**: 存下来的档若不在该模型的 effort_map 内, 菜单回落
 * 到默认档显示, 而发送路径照发原值。下游 resolveEffortPayload 认不出就返回空 payload
 * (只有一条 console.warn), 于是"显示 High、实际什么都没应用"。这类不一致是无声的。
 *
 * supported 传 undefined 表示**还不知道**该模型支持哪些档 (schema 尚未取回) ——
 * 这时保持原值, 不要擅自清空: 清空等于把用户明确选过的档悄悄降级。
 */
export function resolveSendableEffort(
  saved: string | undefined,
  supported: readonly string[] | undefined,
): string | undefined {
  if (!saved || saved === EFFORT_STANDARD) return undefined;
  if (!supported) return saved;
  return supported.includes(saved) ? saved : undefined;
}

export function withModeDefaultEffort(
  sendable: string,
  agentMode: string | null | undefined,
  levels: readonly string[] | undefined,
): string {
  if (agentMode === 'work' && sendable === EFFORT_STANDARD && levels?.includes('low')) return 'low';
  return sendable;
}

export function sendableEffortFor(
  prefs: EffortPrefs,
  modelId: string | undefined,
  supportedByModel: ReadonlyMap<string, readonly string[]>,
): string {
  if (!modelId) return EFFORT_STANDARD;
  return resolveSendableEffort(effectiveEffort(prefs, modelId), supportedByModel.get(modelId)) ?? EFFORT_STANDARD;
}
