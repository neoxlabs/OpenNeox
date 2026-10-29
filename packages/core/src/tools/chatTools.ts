import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { shapeChatWebSearch } from './webSearchShaping.js';

/** 一轮最多搜几次。并发发出, 同时跑; 正常问题 1~3 次就够, 10 是防跑飞的保险丝。 */
export const CHAT_SEARCH_LIMIT = 10;

/**
 * 聊天档带的工具, 顺序固定 —— 工具表每轮逐字节一致, 前缀缓存才不断。
 * 池子里没有某一个 (未登录没托管搜索 / 极简版裁掉画图) 就只带另一个。
 */
export const CHAT_TOOL_NAMES = ['web_search', 'generate_image'] as const;

/** 一轮最多 maxCalls 次搜索; 到顶不再打网关, 直接回一句人话让模型改成作答。 */
export function capWebSearchTool(tool: Tool, maxCalls = CHAT_SEARCH_LIMIT): Tool {
  let used = 0;
  return {
    ...tool,
    function: async (args, context) => {
      if (used >= maxCalls) {
        /* 回给模型的不是网关错误, 而是「别再搜, 用已有结果答」—— 它得能直接切换成作答 */
        return `这一轮已经搜了 ${maxCalls} 次, 到上限了。不要再搜, 用已经拿到的结果直接回答; `
          + '还缺的信息就跟用户说清哪部分没查到。';
      }
      used++;
      return tool.function(args, context);
    },
  };
}

/** 参数的规范串 (键排序) —— 用来判断「同工具同参数」。 */
function canonicalArgs(args: unknown): string {
  const sortValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = sortValue((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  try {
    return JSON.stringify(sortValue(args ?? {}));
  } catch {
    return String(args);
  }
}

/**
 * 防跑飞 (总控裁决第六节): 同一轮里同工具同参数再调一次, 直接拦。
 *
 * 不是在省钱上抠额度 —— 是在模型卡进「原样重发」的死循环时把它拽出来:
 * 同样的参数再跑一遍只会拿到同样的结果, 白等一轮 (搜索) 或白花一笔 (出图)。
 * 只记**已经成功返回**的调用: 上一次失败 (抛异常) 时重试是正当的。
 */
export function guardRepeatedCalls(tool: Tool): Tool {
  const done = new Set<string>();
  /* 在飞的调用也要记 —— 同一轮的多个调用是**并发**跑的, 第二个同参数调用可能在
   * 第一个还没返回时就到了。那时只查 done 会漏拦, 两份搜索/两张一样的图就都出去了。 */
  const inflight = new Map<string, Promise<unknown>>();
  return {
    ...tool,
    function: async (args, context) => {
      const key = canonicalArgs(args);
      if (done.has(key)) {
        return `你刚刚已经用同样的参数调用过 ${tool.name}, 结果就在上面的对话里。`
          + '不要重复调用 —— 直接用那个结果; 要不同结果就换参数。';
      }
      const running = inflight.get(key);
      if (running) {
        /* 等它跑完再回话: 模型看到的是「已经有结果了」, 而不是两条并行结果 */
        await running.catch(() => {});
        return `你刚刚已经用同样的参数调用过 ${tool.name}, 结果就在上面的对话里。`
          + '不要重复调用 —— 直接用那个结果; 要不同结果就换参数。';
      }
      const promise = Promise.resolve().then(() => tool.function(args, context));
      inflight.set(key, promise);
      try {
        const result = await promise;
        done.add(key);
        return result;
      } finally {
        inflight.delete(key);
      }
    },
  };
}

/**
 * 聊天档的工具并发安全: 搜索只读; 出图各写各的文件 (工作区里按日期 + 参数命名),
 * 同参数的重复调用已经被 guardRepeatedCalls 拦掉了, 不会两张图抢同一个路径。
 */
export function markChatToolParallel(tool: Tool): Tool {
  return { ...tool, parallelSafety: 'safe' };
}

/** 从可用工具池里挑出聊天档那两件; 池子里没有的就不给, 不现编。 */
export function buildChatModeTools(allTools: Tool[]): Tool[] {
  const byName = new Map(allTools.map((t) => [t.name, t]));
  const picked: Tool[] = [];
  const search = byName.get('web_search');
  if (search) {
    /* 整形层 (chat:C3-04 / C3-06 / C3-07): 同域最多 2 条、注入 ≤1500 token、3s 截止。
     * 放在 cap 外层还是内层都一样计数; 放这里 = Work / Code 的 web_search 一个字节不变。 */
    picked.push(guardRepeatedCalls(markChatToolParallel(shapeChatWebSearch(capWebSearchTool(search)))));
  }
  const image = byName.get('generate_image');
  if (image) picked.push(guardRepeatedCalls(markChatToolParallel(image)));
  return picked;
}

/**
 * 本轮的工具集: 聊天档换成搜索 + 画图, 其它模式**原样返回同一个数组**
 * (不重排、不包装 —— Work / Code 的工具表和行为一个字节都不变)。
 */
export function selectToolsForTurn(allTools: Tool[], chatMode: boolean): Tool[] {
  return chatMode ? buildChatModeTools(allTools) : allTools;
}

/**
 * 这一轮真正带上的聊天工具 (供提示词如实描述能力)。
 *
 * 只看**选完之后**的工具表, 不看池子: 池子里有、被模式裁掉的也算没有 ——
 * 提示词说「你能画图」而工具表里没有 generate_image, 模型就会手写调用语法。
 */
export function chatToolsAvailability(tools: Tool[]): { search: boolean; image: boolean } {
  const names = new Set(tools.map((t) => t.name));
  return { search: names.has('web_search'), image: names.has('generate_image') };
}
