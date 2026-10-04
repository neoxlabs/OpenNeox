/**
 * LoopDetectorGate adapter — 把 LoopDetector 包装成 orchestrate 的
 * LoopDetectorGate 接口。
 *
 * 映射关系:
 *   LoopLevel.NONE   → 'none'
 *   LoopLevel.SOFT   → 'soft'(orchestrate 不在 gate 拦, 但会带上 message)
 *   LoopLevel.MEDIUM → 'medium'(同 soft)
 *   LoopLevel.HARD   → 'hard'(orchestrate gate 拦截 + terminateLoop)
 *
 * record 时把 output 喂给 buildOutputSignature, 供 loopDetector 的结果差异豁免
 * (shell stderr 每次不同就放行)使用。
 */

import { LoopLevel, buildOutputSignature } from '../../loopDetector.js';
import type { LoopDetector } from '../../loopDetector.js';
import type { LoopDetectorGate } from '../types.js';

/**
 * 读类工具(readfile / read)在 SOFT/MEDIUM 不产生干预文本, 避免重复读同一文件
 * 的正当场景也被打扰。和 agentLoop.ts 原有的 `shouldSuppressReadIntervention`
 * 逻辑对齐。
 */
const READ_TOOL_NAMES = new Set([
  'readfile', 'read',
  /* 只列 readfile/read 太窄 —— 这些同样是"看一眼"、重复的代价只有 token,
   * 硬拦的代价却是打断模型的收敛。有副作用的工具 (写/删/shell/git) 一个都不在这里。 */
  'search', 'search_files', 'grep', 'glob', 'list_directory', 'show_tree', 'smart_tree',
  'read_document', 'open_surface',
]);

function mapLoopLevel(level: LoopLevel): 'none' | 'soft' | 'medium' | 'hard' {
  switch (level) {
    case LoopLevel.HARD:
      return 'hard';
    case LoopLevel.MEDIUM:
      return 'medium';
    case LoopLevel.SOFT:
      return 'soft';
    default:
      return 'none';
  }
}

export function createLoopAdapter(detector: LoopDetector): LoopDetectorGate {
  return {
    check(toolName, args) {
      const level = detector.detect(toolName, args);
      if (level === LoopLevel.NONE) return { level: 'none' };

      /* Read-only tools receive advisory feedback even at HARD repetition;
       * state-changing tools retain the blocking behavior. */
      const isRead = READ_TOOL_NAMES.has(toolName.toLowerCase());
      if (isRead) {
        if (level !== LoopLevel.HARD) return { level: 'none' };
        try {
          const iv = detector.generateIntervention(level, toolName, args);
          return { level: 'medium', message: iv.message, userNotice: iv.userNotice };
        } catch {
          return { level: 'medium' };
        }
      }

      // 非读类工具, 或 HARD 级别的读类工具 → 返回对应级别 + intervention message
      try {
        const intervention = detector.generateIntervention(level, toolName, args);
        return {
          level: mapLoopLevel(level),
          message: intervention.message,
          userNotice: intervention.userNotice,
        };
      } catch {
        return { level: mapLoopLevel(level) };
      }
    },

    record(toolName, args, status, output) {
      const sig = buildOutputSignature(output);
      detector.record(toolName, args, status, sig);
    },
  };
}
