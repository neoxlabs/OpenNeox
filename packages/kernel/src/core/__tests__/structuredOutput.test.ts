import { describe, it, expect } from 'vitest';
import { StructuredOutputValidator } from '../structuredOutput.js';

const definition = {
  name: 'person',
  schema: {
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'integer' } },
    required: ['name', 'age'],
    additionalProperties: false,
  },
  strict: true,
} as any;

const validator = () => new StructuredOutputValidator(definition);

describe('StructuredOutputValidator.validate', () => {
  it('合法 JSON 通过并返回格式化结果', () => {
    const r = validator().validate('{"name":"Ada","age":36}');
    expect(r.ok).toBe(true);
    expect(r.parsed).toEqual({ name: 'Ada', age: 36 });
    expect(r.normalized).toBe(JSON.stringify({ name: 'Ada', age: 36 }, null, 2));
  });

  it('剥掉 ```json 代码围栏', () => {
    expect(validator().validate('```json\n{"name":"Ada","age":36}\n```').ok).toBe(true);
    expect(validator().validate('```\n{"name":"Ada","age":36}\n```').ok).toBe(true);
  });

  it('空输出 → empty_output', () => {
    for (const v of ['', '   ', null, undefined]) {
      const r = validator().validate(v as any);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('empty_output');
    }
  });

  it('非法 JSON → parse_error', () => {
    const r = validator().validate('{name: Ada}');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('parse_error');
    expect(r.message?.length).toBeGreaterThan(0);
  });

  it('缺必填字段 → schema_mismatch，错误带路径', () => {
    const r = validator().validate('{"name":"Ada"}');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('schema_mismatch');
    expect(r.errors?.some(e => e.includes('age'))).toBe(true);
  });

  it('额外字段单独成句', () => {
    const r = validator().validate('{"name":"Ada","age":1,"extra":true}');
    expect(r.ok).toBe(false);
    expect(r.errors?.some(e => e.includes('should not contain property "extra"'))).toBe(true);
  });

  it('类型不匹配被拦下', () => {
    const r = validator().validate('{"name":123,"age":"x"}');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('schema_mismatch');
  });
});

describe('StructuredOutputValidator — 提示与格式', () => {
  it('responseFormatPayload 默认 strict=true', () => {
    expect(validator().responseFormatPayload).toEqual({
      type: 'json_schema',
      json_schema: { name: 'person', schema: definition.schema, strict: true },
    });
    const loose = new StructuredOutputValidator({ ...definition, strict: false });
    expect(loose.responseFormatPayload.json_schema.strict).toBe(false);
  });

  it('buildSystemPrompt 带 schema 名与内容', () => {
    const prompt = validator().buildSystemPrompt();
    expect(prompt).toContain('person');
    expect(prompt).toContain('"name"');
    expect(prompt).toContain('Do not include explanations');
  });

  it('buildRetryPrompt 优先列具体错误', () => {
    const prompt = validator().buildRetryPrompt({ ok: false, reason: 'schema_mismatch', message: 'm', errors: ['e1', 'e2'] } as any);
    expect(prompt).toContain('Validation issues:');
    expect(prompt).toContain('- e1');
    expect(prompt).toContain('- e2');
  });

  it('buildRetryPrompt 无 errors 时用 message', () => {
    const prompt = validator().buildRetryPrompt({ ok: false, reason: 'parse_error', message: 'bad json' } as any);
    expect(prompt).toContain('Validation issue: bad json');
    expect(prompt).toContain('Return ONLY valid minified JSON');
  });
});

describe('StructuredOutputValidator.getProviderParams', () => {
  it('OpenAI / gpt / o 系走 json_schema', () => {
    for (const [p, m] of [['openai', 'x'], ['x', 'gpt-4o'], ['x', 'o3-mini'], ['', 'o1']] as const) {
      const params = validator().getProviderParams(p, m);
      expect(params.responseFormat?.type, `${p}/${m}`).toBe('json_schema');
    }
  });

  it('Anthropic / claude 走 tool_use 模拟', () => {
    for (const [p, m] of [['anthropic', ''], ['', 'claude-sonnet']] as const) {
      const params = validator().getProviderParams(p, m);
      expect(params._structuredOutputTool.name).toBe('output_person');
      expect(params.toolChoice).toEqual({ type: 'tool', name: 'output_person' });
    }
  });

  it('Gemini / google 走 responseMimeType', () => {
    for (const [p, m] of [['gemini', ''], ['google', ''], ['', 'gemini-2.5']] as const) {
      expect(validator().getProviderParams(p, m)).toMatchObject({ responseMimeType: 'application/json' });
    }
  });

  it('DeepSeek 走 json_object', () => {
    expect(validator().getProviderParams('deepseek', 'deepseek-chat')).toEqual({ responseFormat: { type: 'json_object' } });
  });

  it('未知 provider 兜底为 system 提示', () => {
    const params = validator().getProviderParams('weird', 'unknown-model');
    expect(params._systemSuffix).toContain('person');
  });
});
