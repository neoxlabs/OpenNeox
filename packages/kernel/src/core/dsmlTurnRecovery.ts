
import { parseDsmlToolCalls } from '../utils/dsmlToolCalls.js';
import { parseXmlToolCalls } from '../utils/xmlToolCalls.js';
import type { ToolCall } from '../types/index.js';

/** 同一轮最多重来几次 (第一次残缺之后还能再试 2 次) */
export const MAX_DSML_RETRIES = 2;

/** 追加到对话尾部让模型重来的提示 */
export const DSML_INCOMPLETE_HINT =
  '你上一条回复里的工具调用格式不完整, 没有执行。请用正常的函数调用重新发起;'
  + ' 如果不需要调用工具, 直接给出回答。';

export interface DsmlTurnRecovery {
  /** 解析回的完整调用 (可能为空) */
  toolCalls: ToolCall[];
  /** 摘掉 DSML 残片之后要展示 / 入库的正文 */
  text: string;
  /** 见到过 DSML 标记 */
  sawIncomplete: boolean;
  /** 残缺, 应追加提示让模型重来这一轮 */
  retry: boolean;
  /** 重来次数已用尽, 应如实结束 */
  giveUp: boolean;
  /** 更新后的连续残缺计数 (完整解析 / 正常回复归零) */
  retries: number;
}

/**
 * 把一轮助手正文里的 DSML 形态调用翻译成结构化调用, 并决定要不要让模型重来。
 *
 * 完整调用照旧直接执行 (哪怕尾巴上还挂着截断的第二个 invoke) —— 跟原行为一致;
 * 一个 invoke 都解析不出、但正文里有 DSML 痕迹 → 算残缺。
 */
export function applyDsmlToolCallsToTurn(content: string, retries: number): DsmlTurnRecovery {
  const parsed = parseDsmlToolCalls(content);

  /* DSML 一个调用都没解出来时, 再看纯 XML 形态 (没有竖线那种)。
   * 顺序固定: 先 DSML (它会把 ｜DSML｜ 残片摘干净), 再把剩下的正文交给 XML 解析器。 */
  let calls = parsed.calls;
  let text = parsed.text;
  let sawIncomplete = parsed.sawIncomplete;
  if (calls.length === 0) {
    const xml = parseXmlToolCalls(text);
    calls = xml.calls;
    text = xml.text;
    sawIncomplete = sawIncomplete || xml.sawIncomplete;
  }

  if (calls.length > 0) {
    const toolCalls: ToolCall[] = calls.map((c, i) => ({
      id: `call_dsml_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: { name: c.name, arguments: c.arguments },
    }));
    return {
      toolCalls,
      text,
      sawIncomplete,
      retry: false,
      giveUp: false,
      retries: 0,
    };
  }

  if (!sawIncomplete) {
    /* 正常回复 (没有文本形态调用痕迹) —— 上一轮的残缺计数到此为止 */
    return {
      toolCalls: [],
      text,
      sawIncomplete: false,
      retry: false,
      giveUp: false,
      retries: 0,
    };
  }

  const next = retries + 1;
  return {
    toolCalls: [],
    text,
    sawIncomplete: true,
    retry: next <= MAX_DSML_RETRIES,
    giveUp: next > MAX_DSML_RETRIES,
    retries: next,
  };
}
