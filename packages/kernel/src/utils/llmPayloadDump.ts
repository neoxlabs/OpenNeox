/**
 * LLM Payload Dump — 把每次发往上游 LLM 的完整 request payload 落盘.
 *
 * 用途: 适配新模型 / 排查"模型自我描述污染"等问题时, 直接看 client 实际发出去的
 *   messages + tools + system 全文, 不用猜.
 *
 * 默认关闭. 启用方式:
 *   NEOX_DUMP_LLM=1 npm run ui:dev
 *
 * 输出位置 (默认): ~/.neox/logs/neox-llm-payload-YYYY-MM-DD.jsonl
 *   每行一条 JSON: { ts, source, model, ...payload-fields }
 *
 * 自定义目录: NEOX_DUMP_LLM_DIR=/some/path
 *
 * 调用点: 各 provider 的 chatStreamed 入口 + agentLoop 的 provider.chatStreamed 之前.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { NEOX_HOME_DIRNAME } from '../platform/neoxHome.js';

const ENABLED = ((): boolean => {
  const v = process.env.NEOX_DUMP_LLM;
  return v === '1' || v === 'true' || v === 'yes';
})();

const DUMP_DIR = process.env.NEOX_DUMP_LLM_DIR || join(homedir(), NEOX_HOME_DIRNAME, 'logs');

export function isLLMDumpEnabled(): boolean {
  return ENABLED;
}

/** 落一行 JSON. 自动加 ts 字段. record 里的 source 字段建议必填(标识调用点). */
export function dumpLLMPayload(record: Record<string, unknown>): void {
  if (!ENABLED) return;
  try {
    mkdirSync(DUMP_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const file = join(DUMP_DIR, `neox-llm-payload-${today}.jsonl`);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
    appendFileSync(file, line + '\n');
  } catch (err) {
    /* 失败大声报, 不静默吞 — 静默吞 bug 调试痛苦. */
    try {
      console.error('[NEOX_DUMP_LLM] write failed:', (err as { message?: string })?.message || err);
    } catch { /* console 都崩了就放弃 */ }
  }
}
