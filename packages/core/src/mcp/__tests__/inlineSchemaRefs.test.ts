import { describe, expect, it } from 'vitest';
import { inlineSchemaRefs } from '../inlineSchemaRefs.js';

describe('inlineSchemaRefs', () => {
  it('展开 $defs 引用, 结果里不再有 $ref / $defs (DeepSeek: Pointer /$defs/__schema2 does not exist)', () => {
    const s = {
      type: 'object',
      properties: {
        fn: { $ref: '#/$defs/__schema2', description: '要标注的函数' },
        list: { type: 'array', items: { $ref: '#/definitions/Item' } },
      },
      required: ['fn'],
      $defs: { __schema2: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
      definitions: { Item: { type: 'string', enum: ['a', 'b'] } },
    };
    const out = inlineSchemaRefs(s);
    expect(JSON.stringify(out)).not.toMatch(/\$ref|\$defs|definitions/);
    expect(out.properties.fn).toEqual({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'], description: '要标注的函数' });
    expect(out.properties.list.items).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(s.properties.fn.$ref).toBe('#/$defs/__schema2');
  });

  it('自引用 (树) 不无限展开, 悬空引用换成不带约束的 {}', () => {
    const s = {
      type: 'object',
      properties: { root: { $ref: '#/$defs/Node' }, ghost: { $ref: '#/$defs/Missing', description: 'x' } },
      $defs: { Node: { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/$defs/Node' } } } } },
    };
    const out = inlineSchemaRefs(s);
    expect(JSON.stringify(out)).not.toMatch(/\$ref/);
    expect(out.properties.root.properties.children.items).toEqual({});
    expect(out.properties.ghost).toEqual({ description: 'x' });
  });
});
