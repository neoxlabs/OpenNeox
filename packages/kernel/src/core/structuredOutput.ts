/**
 * 结构化输出验证
 *
 * Providers use their native structured-output mode when available; other
 * providers receive prompt guidance and all responses are validated with AJV.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { StructuredOutputDefinition, StructuredOutputValidationResult } from '../types/index.js';

const ajv = new Ajv({
  allErrors: true,
  strict: false,
});

function stripCodeFences(raw: string): string {
  const trimmed = (raw || '').trim();
  if (trimmed.startsWith('```')) {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return trimmed;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) {
    return [];
  }
  return errors.map((err) => {
    const path = err.instancePath || err.schemaPath || '';
    if (err.keyword === 'additionalProperties' && typeof err.params?.additionalProperty === 'string') {
      return `${path} should not contain property "${err.params.additionalProperty}"`;
    }
    return `${path} ${err.message || ''}`.trim();
  });
}

export class StructuredOutputValidator {
  private validateFn: ValidateFunction;

  constructor(private definition: StructuredOutputDefinition) {
    this.validateFn = ajv.compile(definition.schema);
  }

  get responseFormatPayload(): Record<string, any> {
    return {
      type: 'json_schema',
      json_schema: {
        name: this.definition.name,
        schema: this.definition.schema,
        strict: this.definition.strict ?? true,
      },
    };
  }

  buildSystemPrompt(): string {
    const schemaPretty = JSON.stringify(this.definition.schema, null, 2);
    return [
      `You must respond with valid JSON that exactly matches the schema "${this.definition.name}".`,
      'Do not include explanations, markdown code fences, or additional commentary.',
      'Schema:',
      schemaPretty,
    ].join('\n\n');
  }

  validate(rawOutput: string | null | undefined): StructuredOutputValidationResult {
    const extracted = stripCodeFences(rawOutput || '');
    if (!extracted) {
      return {
        ok: false,
        reason: 'empty_output',
        message: 'The model returned an empty response.',
      };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(extracted);
    } catch (error: any) {
      return {
        ok: false,
        reason: 'parse_error',
        message: error?.message || 'Failed to parse JSON output.',
      };
    }

    const isValid = this.validateFn(parsed);
    if (!isValid) {
      const formattedErrors = formatAjvErrors(this.validateFn.errors);
      return {
        ok: false,
        reason: 'schema_mismatch',
        message: 'Response does not match the required JSON schema.',
        errors: formattedErrors,
      };
    }

    return {
      ok: true,
      parsed,
      normalized: JSON.stringify(parsed, null, 2),
    };
  }

  buildRetryPrompt(error: StructuredOutputValidationResult): string {
    const parts = [
      `Your previous response did not satisfy the required JSON schema "${this.definition.name}".`,
    ];

    if (error.errors && error.errors.length > 0) {
      parts.push('Validation issues:\n- ' + error.errors.join('\n- '));
    } else if (error.message) {
      parts.push(`Validation issue: ${error.message}`);
    }

    parts.push(
      'Return ONLY valid minified JSON (no code fences, no commentary) that matches the schema below:',
      JSON.stringify(this.definition.schema, null, 2),
    );

    return parts.join('\n\n');
  }

  // Select provider-specific structured-output parameters.

  /**
   * 根据 provider 获取最佳的结构化输出参数
   *
   * 返回应添加到 LLM chat options 中的参数
   */
  getProviderParams(provider?: string, model?: string): Record<string, any> {
    const lp = (provider || '').toLowerCase();
    const lm = (model || '').toLowerCase();

    // OpenAI: 原生 json_schema
    if (lp.includes('openai') || lm.startsWith('gpt') || lm.startsWith('o1') || lm.startsWith('o3') || lm.startsWith('o4')) {
      return { responseFormat: this.responseFormatPayload };
    }

    // Anthropic: tool_use 模拟
    if (lp.includes('anthropic') || lm.startsWith('claude')) {
      return {
        _structuredOutputTool: {
          name: `output_${this.definition.name}`,
          description: `Respond with structured data matching schema: ${this.definition.name}`,
          input_schema: this.definition.schema,
        },
        toolChoice: { type: 'tool', name: `output_${this.definition.name}` },
      };
    }

    // Gemini: response_mime_type
    if (lp.includes('gemini') || lp.includes('google') || lm.startsWith('gemini')) {
      return {
        responseMimeType: 'application/json',
        responseSchema: this.definition.schema,
      };
    }

    // DeepSeek: json_object
    if (lp.includes('deepseek') || lm.startsWith('deepseek')) {
      return { responseFormat: { type: 'json_object' } };
    }

    // 兜底: prompt instruction
    return { _systemSuffix: this.buildSystemPrompt() };
  }
}
