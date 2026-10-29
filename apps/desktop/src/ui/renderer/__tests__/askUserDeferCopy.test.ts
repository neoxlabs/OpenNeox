import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { deferToAgentAnswer } from '../modules/agent-timeline/cells/AskUserView';

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const read = (rel: string) => strip(readFileSync(resolve(HERE, rel), 'utf8'));

const askView = read('../modules/agent-timeline/cells/AskUserView.tsx');
const timeline = read('../modules/agent-timeline/AgentTimelineView.tsx');

describe('「让 AI 自己定」的答复文案', () => {
  it('不许再出现「拒绝」—— 用户点的按钮不是这个意思', () => {
    expect(deferToAgentAnswer(true)).not.toMatch(/拒绝/);
    expect(deferToAgentAnswer(false).toLowerCase()).not.toMatch(/decline|reject/);
  });

  it('中英文都要有, 且英文里不许残留中文', () => {
    expect(deferToAgentAnswer(true)).toMatch(/[一-龥]/);
    expect(deferToAgentAnswer(false)).not.toMatch(/[一-龥]/);
  });

  it('消费方都走同一个函数 —— 不许再各写一份字面量', () => {
    for (const [name, src] of [['AskUserView', askView], ['AgentTimelineView', timeline]] as const) {
      expect(src, `${name} 没用 deferToAgentAnswer`).toMatch(/deferToAgentAnswer\(/);
      expect(src, `${name} 里还留着写死的答复文案`).not.toMatch(/拒绝选择这些选项/);
    }
  });

  it('按钮文字仍是「让 AI 自己定」/ Let AI decide —— 它变了这句答复也要跟着变', () => {
    expect(askView).toMatch(/'让 AI 自己定' : 'Let AI decide'/);
  });
});
