/** Accept the supported object and array shapes for form-field arguments. */
import { describe, it, expect } from 'vitest';
import { normalizeFormFields } from '../browserTools.js';

describe('fill_form 的 fields', () => {
  it('对象 map', () => {
    expect(normalizeFormFields({ '#u': 'admin', '#p': 'x' })).toEqual([
      { selector: '#u', value: 'admin' }, { selector: '#p', value: 'x' },
    ]);
  });
  it('数组 {selector,value} 原样; {name,value} → [name=…]; {id,value} → #id', () => {
    expect(normalizeFormFields([{ selector: '#u', value: 'a' }, { name: 'pass', value: 'b' }, { id: 'q', value: 1 }])).toEqual([
      { selector: '#u', value: 'a' }, { selector: '[name="pass"]', value: 'b' }, { selector: '#q', value: '1' },
    ]);
  });
  it('垃圾输入 → 空数组 (调用方据此报"需要 fields")', () => {
    expect(normalizeFormFields(undefined)).toEqual([]);
    expect(normalizeFormFields('x')).toEqual([]);
    expect(normalizeFormFields([{ value: 'no selector' }])).toEqual([]);
  });
});

describe('fields 里用 ref', () => {
  it('{ref: 3, value} → [data-neox-ref="3"]', () => {
    expect(normalizeFormFields([{ ref: 3, value: 'admin' }])).toEqual([{ selector: '[data-neox-ref="3"]', value: 'admin' }]);
  });
});
