import { describe, test, expect } from 'vitest';
import { normalizeMermaidSource } from '../Markdown';

describe('normalizeMermaidSource', () => {
  test('subgraph 紧贴中文标题 → 补空格并加引号', () => {
    const out = normalizeMermaidSource('flowchart LR\n subgraph海外用户\n A1[海外用户] --> B\n end');
    expect(out).toContain('subgraph "海外用户"');
    expect(out).not.toContain('subgraph海外用户');
  });

  test('中文标题带空格但没引号 → 补引号', () => {
    expect(normalizeMermaidSource('flowchart LR\n subgraph 你自己\n end'))
      .toContain('subgraph "你自己"');
  });

  test('纯 ASCII 裸词是 id, 绝不能加引号 (加了就打断 S1 --> X 的引用)', () => {
    const src = 'flowchart LR\n subgraph S1\n A --> B\n end\n S1 --> X';
    expect(normalizeMermaidSource(src)).toBe(src);
  });

  test('已经带引号的不动', () => {
    const src = 'flowchart LR\n subgraph "海外用户"\n end';
    expect(normalizeMermaidSource(src)).toBe(src);
  });

  test('id [Title] 方括号形式不动', () => {
    const src = 'flowchart LR\n subgraph s1 [海外用户]\n end';
    expect(normalizeMermaidSource(src)).toBe(src);
  });

  test('不碰 subgraph 之外的行', () => {
    const src = 'flowchart LR\n A1[海外用户] --> B[CF边缘443<br>DDoS吸收]\n C -->|CDN中转节点| B';
    expect(normalizeMermaidSource(src)).toBe(src);
  });

  test('节点标签里的反斜杠 → 加引号包成矩形 (保留原文)', () => {
    const out = normalizeMermaidSource('flowchart LR\n OS[\\ordersys\\Cr\\/整理成 md]');
    expect(out).toContain('OS["\\ordersys\\Cr\\/整理成 md"]');
  });

  test('中段反斜杠也引号化', () => {
    expect(normalizeMermaidSource('flowchart LR\n A[x\\y]')).toContain('A["x\\y"]');
  });

  test('开头斜杠但没正常收尾 (断掉的形状语法) → 引号化', () => {
    expect(normalizeMermaidSource('flowchart LR\n A[/ordersys/Cr]')).toContain('A["/ordersys/Cr"]');
  });

  test('故意的平行四边形 / 斜杠形状不动', () => {
    const a = 'flowchart LR\n A[\\text\\]';
    const b = 'flowchart LR\n A[/text/]';
    expect(normalizeMermaidSource(a)).toBe(a);
    expect(normalizeMermaidSource(b)).toBe(b);
  });

  test('已经带引号 / 普通标签不动', () => {
    const a = 'flowchart LR\n A["已有引号\\x"]';
    const b = 'flowchart LR\n A[普通文本]';
    expect(normalizeMermaidSource(a)).toBe(a);
    expect(normalizeMermaidSource(b)).toBe(b);
  });
});
