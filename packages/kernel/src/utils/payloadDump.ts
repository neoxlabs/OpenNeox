/**
 * payloadDump — 完整 LLM HTTP 请求体落盘。
 *
 * 动机: ~/.neox/logs/llm-requests/iter*.json 只 dump messages 数组, 不含
 * system / tools / thinking / temperature 等 — 用户想看"模型真实收到的完整请求"
 * 时不够。设 NEOX_DUMP_LLM_PAYLOAD=1 后, 各 model client 在发请求前把**整个
 * HTTP body 原样** dump 到 ~/.neox/logs/llm-requests/payload-<protocol>-<ts>.json。
 *
 * 默认关闭 (payload 含完整对话, 大且敏感); fire-and-forget, 失败绝不影响请求。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NEOX_HOME_DIRNAME } from '../platform/neoxHome.js';
import {
  analyzeAnthropicCachePayload,
  formatAnthropicCachePayloadAnalysis,
} from './anthropicCachePayloadAnalysis.js';

let seq = 0;

export function dumpLlmPayloadIfEnabled(protocol: string, payload: unknown): void {
  if (process.env.NEOX_DUMP_LLM_PAYLOAD !== '1') return;
  try {
    const dir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs', 'llm-requests');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `payload-${protocol}-${Date.now()}-${++seq}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    // eslint-disable-next-line no-console
    console.error(`[LLM_PAYLOAD_DUMP] ${file}`);

    if (protocol.startsWith('anthropic')) {
      try {
        const analysis = analyzeAnthropicCachePayload(payload);
        const analysisFile = file.replace(/\.json$/, '.cache-analysis.json');
        const logFile = file.replace(/\.json$/, '.cache-analysis.log');
        const logLines = formatAnthropicCachePayloadAnalysis(analysis);

        fs.writeFileSync(analysisFile, JSON.stringify(analysis, null, 2), 'utf8');
        fs.writeFileSync(logFile, `${logLines.join('\n')}\n`, 'utf8');

        // eslint-disable-next-line no-console
        console.error(`[LLM_PAYLOAD_CACHE] analysis_json=${analysisFile}`);
        // eslint-disable-next-line no-console
        console.error(`[LLM_PAYLOAD_CACHE] analysis_log=${logFile}`);
        for (const line of logLines) {
          // eslint-disable-next-line no-console
          console.error(`[LLM_PAYLOAD_CACHE] ${line}`);
        }
      } catch { /* cache analysis is diagnostic-only */ }
    }
  } catch { /* 绝不影响请求 */ }
}
