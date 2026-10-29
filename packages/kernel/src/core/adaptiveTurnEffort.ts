import { getSchemaRegistry } from '../schemas/loader.js';

const ROUTINE_REASONING_CHARS = 1500;

export function pickAdaptiveTurnEffort(input: {
  model: string | undefined;
  iteration: number;
  lastTurnReasoningChars: number;
  lastToolRoundFailed: boolean;
}): string | undefined {
  if (process.env.NEOX_ADAPTIVE_EFFORT === '0') return undefined;
  if (!input.model || input.iteration <= 1) return undefined;
  if (input.lastToolRoundFailed) return undefined;
  if (!(input.lastTurnReasoningChars < ROUTINE_REASONING_CHARS)) return undefined;
  const schema = getSchemaRegistry().resolveModel(input.model);
  if (schema?.family !== 'deepseek' || !schema.effort_map?.low) return undefined;
  return 'low';
}
