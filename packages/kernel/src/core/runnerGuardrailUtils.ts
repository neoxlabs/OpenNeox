import type {
  OutputGuardrail,
  RawResponseStreamEvent,
  RunContext,
} from '../types/index.js';
import { GuardrailsExecutor } from './guardrails.js';

export async function* runOutputGuardrailsWithEvents(options: {
  outputGuardrails: OutputGuardrail[];
  context: RunContext;
  agentName: string;
  finalOutput: string;
}): AsyncGenerator<RawResponseStreamEvent> {
  const { outputGuardrails, context, agentName, finalOutput } = options;
  if (outputGuardrails.length === 0 || !finalOutput) {
    return;
  }

  yield {
    type: 'raw_response_event',
    data: {
      type: 'output_guardrails.check_start',
      count: outputGuardrails.length,
    },
    event_type: 'output_guardrails.check_start',
  } as RawResponseStreamEvent;

  await GuardrailsExecutor.runOutputGuardrails(
    outputGuardrails,
    context,
    agentName,
    finalOutput,
  );

  yield {
    type: 'raw_response_event',
    data: {
      type: 'output_guardrails.check_passed',
    },
    event_type: 'output_guardrails.check_passed',
  } as RawResponseStreamEvent;
}
