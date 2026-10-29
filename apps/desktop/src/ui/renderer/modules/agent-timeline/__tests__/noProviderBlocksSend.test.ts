import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, '..', 'TimelineComposer.tsx'), 'utf8');

const composer = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
  .replace(/^\s*\/\/.*$/gm, '');       // 行注释

describe('没有可用模型时禁止发送', () => {
  it('发送按钮 disabled 挂在 canSend 上', () => {
    expect(composer).toMatch(/disabled=\{!canSend\}/);
  });

  it('canSend 含 !needsProviderSetup', () => {
    const i = composer.indexOf('const canSend =');
    expect(i, '找不到 canSend 定义').toBeGreaterThan(-1);
    expect(composer.slice(i, i + 600)).toContain('!needsProviderSetup');
  });

  it('回车分支在 submit() 之前也断掉 —— 这就是当初漏掉的那条路', () => {
    const i = composer.indexOf("if (e.key === 'Enter' && !e.shiftKey");
    expect(i, '找不到回车发送分支').toBeGreaterThan(-1);
    const seg = composer.slice(i, composer.indexOf('submit();', i) + 'submit();'.length);
    expect(seg, '回车绕过了 needsProviderSetup').toContain('needsProviderSetup');
  });
});

describe('没配来源的提示形态', () => {
  it('是药丸, 不是输入框里的全宽横幅', () => {
    expect(composer).toContain('atl-composer__pill--setup');
    expect(composer, '旧的全宽横幅应该已经删干净').not.toContain('atl-composer__setup-hint');
  });

  it('药丸带一个去配置的出路 —— 光禁不给出路等于换了个困惑', () => {
    const i = composer.indexOf('atl-composer__pill--setup');
    const seg = composer.slice(i, i + 900);
    expect(seg).toContain('atl-composer__pill-act');
    expect(seg).toContain("neox:open-model-connect");
  });
});
