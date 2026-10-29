import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NeoxCard } from '../NeoxCards';

const gauge = JSON.stringify({ title: '9B Q4 跑 32k 上下文的内存占用', type: 'gauge', max: 10.7, unit: 'GB', series: [{ label: '权重 6.1 + KV 3.9', value: 10.04 }] });

describe('chart subtype as card kind', () => {
  it('neox-card:gauge 渲染成环形图', () => {
    const html = renderToStaticMarkup(<NeoxCard kind="gauge" body={gauge} />);
    expect(html).toContain('nchart__gauge');
    expect(html).toContain('权重 6.1 + KV 3.9');
  });

  it('JSON 里没写 type 时用种类名补上', () => {
    const body = JSON.stringify({ title: 'x', series: [{ label: 'a', value: 30 }], max: 100 });
    expect(renderToStaticMarkup(<NeoxCard kind="gauge" body={body} />)).toContain('nchart__gauge');
  });

  it('真不认识的种类仍然不渲染 (交给代码块)', () => {
    expect(renderToStaticMarkup(<NeoxCard kind="whatever" body={gauge} />)).toBe('');
  });
});
