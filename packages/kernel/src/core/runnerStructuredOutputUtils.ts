import type { RawResponseStreamEvent } from '../types/index.js';
import type { StructuredOutputValidator } from './structuredOutput.js';

export type StructuredOutputProcessResult =
  | {
    kind: 'retry';
    event: RawResponseStreamEvent;
    retryPrompt: string;
  }
  | {
    kind: 'accepted';
    finalOutput: string;
    event?: RawResponseStreamEvent;
  };

export function processStructuredOutput(options: {
  fullContent: string;
  validator?: StructuredOutputValidator;
  schemaName?: string;
}): StructuredOutputProcessResult {
  const { fullContent, validator, schemaName } = options;
  if (!validator) {
    return { kind: 'accepted', finalOutput: fullContent };
  }

  const validation = validator.validate(fullContent);
  if (!validation.ok) {
    return {
      kind: 'retry',
      event: {
        type: 'raw_response_event',
        data: {
          type: 'structured_output.retry',
          schema: schemaName,
          reason: validation.reason,
          message: validation.message,
          errors: validation.errors,
        },
        event_type: 'structured_output.retry',
      } as RawResponseStreamEvent,
      retryPrompt: validator.buildRetryPrompt(validation),
    };
  }

  const finalOutput = validation.normalized || fullContent;
  return {
    kind: 'accepted',
    finalOutput,
    event: {
      type: 'raw_response_event',
      data: {
        type: 'structured_output.accepted',
        schema: schemaName,
        normalized_text: finalOutput,
        parsed: validation.parsed,
      },
      event_type: 'structured_output.accepted',
    } as RawResponseStreamEvent,
  };
}
