/**
 * Gemini Provider Constraints
 *
 * Minimal validation rules for Google Gemini API.
 */

import {
  BaseConstraints,
  type ProviderConstraints,
  rangeValidator,
  typeValidator,
} from './base.js';

export class GeminiConstraints extends BaseConstraints {
  getConstraints(): ProviderConstraints {
    return {
      maxOutputTokens: {},
      maxInputTokens: {},

      supportedParams: new Set([
        'model',
        'messages',
        'stream',
        'max_tokens',
        'temperature',
        'topP',
        'topK',
        'stopSequences',
        'tools',
        'structuredOutput',
        'signal',
      ]),

      validators: {
        temperature: rangeValidator(0, 2),
        topP: rangeValidator(0, 1),
        topK: rangeValidator(1, 128),
        max_tokens: (value: any) => {
          const num = Number(value);
          if (Number.isNaN(num)) return 'Must be a number';
          if (num < 1) return 'Must be at least 1';
          return true;
        },
        stopSequences: (value: any) => {
          if (!Array.isArray(value)) {
            return 'Must be an array of strings';
          }
          const invalid = value.some((item) => typeof item !== 'string' || item.length === 0);
          return invalid ? 'All stop sequences must be non-empty strings' : true;
        },
        stream: typeValidator('boolean'),
      },

      defaults: {
        temperature: 1.0,
      },
    };
  }
}
