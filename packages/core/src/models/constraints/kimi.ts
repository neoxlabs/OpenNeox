/**
 * Kimi Provider Constraints
 *
 * Kimi API is largely OpenAI-compatible with a few differences:
 * - temperature range: [0, 1]
 * - temperature ~0 requires n=1
 * - tool_choice=required is not supported
 * - 所有线上模型 temperature 必须为 1 (见下方常量注释)
 */

import { OpenAIConstraints } from './openai.js';
import { rangeValidator } from './base.js';
import type { ProviderConstraints } from './base.js';

/** Kimi 模型默认要求 temperature=1；允许自定义温度的模型显式列入例外集合。 */
const CUSTOM_TEMPERATURE_MODELS: readonly string[] = [];

export function isFixedTemperatureModel(model: string): boolean {
  return !CUSTOM_TEMPERATURE_MODELS.includes(model);
}

export class KimiConstraints extends OpenAIConstraints {
  getConstraints(): ProviderConstraints {
    const base = super.getConstraints();
    const validators = { ...(base.validators ?? {}) };

    // Kimi temperature range is [0, 1].
    validators.temperature = rangeValidator(0, 1);

    const baseToolChoice = validators.tool_choice;
    validators.tool_choice = (value: any) => {
      if (value === 'required') {
        return 'tool_choice=required is not supported by Kimi API';
      }
      return typeof baseToolChoice === 'function' ? baseToolChoice(value) : true;
    };

    const baseNValidator = validators.n;
    validators.n = (value: any, params?: Record<string, any>) => {
      const result = typeof baseNValidator === 'function' ? baseNValidator(value, params) : true;
      if (result !== true) return result;

      const tempValue = params?.temperature ?? 1;
      const temp = typeof tempValue === 'number' ? tempValue : Number(tempValue);
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isNaN(temp) && temp <= 0.001 && n > 1) {
        return 'temperature <= 0.001 requires n=1 for Kimi API';
      }
      return true;
    };

    return {
      ...base,
      validators,
    };
  }
}
