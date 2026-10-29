
import { dropDiscardedTail } from './agentRuntimeHostHelpers.js';

/** [fullResponse, lastAssistantMessage, currentTurnText] */
export type TurnTextAccumulators = [string, string, string];

export function dropIncompleteTurnTail(
  acc: TurnTextAccumulators,
  data: unknown,
): TurnTextAccumulators {
  const discarded = (data as { discardedText?: unknown } | undefined)?.discardedText;
  const gone = typeof discarded === 'string' ? discarded : '';
  /* 没带正文 (老 kernel / 云端没透传) → 原样不动: 不知道要撤哪一段, 宁可留着也不乱切 */
  if (!gone) return acc;
  return [
    dropDiscardedTail(acc[0], gone),
    dropDiscardedTail(acc[1], gone),
    dropDiscardedTail(acc[2], gone),
  ];
}
