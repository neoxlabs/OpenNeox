import type { RawResponseStreamEvent } from '../types/index.js';
import {
  buildRepairPrompt,
  detectMalformedToolCall,
  type RepairTracker,
} from './toolCallRepair.js';

export type XmlFragmentRepairAction = {
  pattern: string;
  contentPreview: string;
  iteration: number;
  repairAttempt: number;
  assistantContent: string;
  systemPrompt: string;
  event: RawResponseStreamEvent;
};

export function getXmlFragmentRepairAction(options: {
  fullContent: string;
  repairTracker: RepairTracker;
  iteration: number;
}): XmlFragmentRepairAction | null {
  const { fullContent, repairTracker, iteration } = options;
  if (!fullContent || repairTracker.shouldGiveUp('xml_fragment')) {
    return null;
  }

  const malformed = detectMalformedToolCall(fullContent);
  if (!malformed.detected) {
    return null;
  }

  repairTracker.record(iteration, 'xml_fragment');

  return {
    pattern: malformed.pattern || 'unknown',
    contentPreview: fullContent.slice(0, 200),
    iteration,
    repairAttempt: repairTracker.getSummary().total,
    assistantContent: malformed.cleanContent || '(输出被截断)',
    systemPrompt: buildRepairPrompt('xml_fragment', fullContent),
    event: {
      type: 'raw_response_event',
      data: {
        type: 'tool_repair.xml_fragment',
        pattern: malformed.pattern,
        iteration,
      },
      event_type: 'tool_repair.xml_fragment',
    } as RawResponseStreamEvent,
  };
}
