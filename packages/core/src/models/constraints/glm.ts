/**
 * GLM Provider Constraints (智谱 AI)
 *
 * GLM API is OpenAI-compatible with differences:
 * - temperature range: [0, 1] (GLM-4 series)
 * - top_p range: [0, 1]
 * - tool_choice=required is not supported
 */

import { OpenAIConstraints } from './openai.js';
import { rangeValidator } from './base.js';
import type { ProviderConstraints } from './base.js';

export class GLMConstraints extends OpenAIConstraints {
  getConstraints(): ProviderConstraints {
    const base = super.getConstraints();
    const validators = { ...(base.validators ?? {}) };

    // GLM temperature range is [0, 1]
    validators.temperature = rangeValidator(0, 1);

    // GLM top_p range is [0, 1]
    validators.top_p = rangeValidator(0, 1);

    // tool_choice=required is not supported by GLM
    const baseToolChoice = validators.tool_choice;
    validators.tool_choice = (value: any) => {
      if (value === 'required') {
        return 'tool_choice=required is not supported by GLM API';
      }
      return typeof baseToolChoice === 'function' ? baseToolChoice(value) : true;
    };

    return {
      ...base,
      validators,
    };
  }
}
