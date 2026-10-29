import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '../tabs/StorageTab.tsx'), 'utf8');

describe('图例判定用 name, 不用 key', () => {
  it('segment 里把 name 单列出来了 —— 不列就只能拿 path 去猜', () => {
    const i = SRC.indexOf('.map(f => ({');
    expect(i).toBeGreaterThan(0);
    const block = SRC.slice(i, i + 700);
    expect(block).toMatch(/key: f\.path,/);
    expect(block, 'segment 没有 name 字段').toMatch(/name: f\.name,/);
  });

  it('staleKind 三档全部走 s.name', () => {
    const i = SRC.indexOf('const staleKind =');
    expect(i).toBeGreaterThan(0);
    const block = SRC.slice(i, i + 260);
    for (const key of ['neox.db.backups', 'bin/.stale', 'semantic/.orphan']) {
      expect(block, `${key} 仍在拿 key 判`).toContain(`s.name === '${key}'`);
    }
    expect(block, 'staleKind 里还留着 s.key 比较').not.toMatch(/s\.key ===/);
  });

  it('语音模型那颗也走 s.name', () => {
    expect(SRC).toMatch(/const isVoiceModels = s\.name === 'models\/';/);
  });

  it('整个图例块里不许再出现 `s.key === ` —— key 是路径, 拿它比常量必然恒假', () => {
    const i = SRC.indexOf('const staleKind =');
    const j = SRC.indexOf('</div>', SRC.indexOf('lg-clean', i));
    expect(SRC.slice(i, j)).not.toMatch(/s\.key === '/);
  });
});

describe('语音模型给的是"去处"而不是"一键清空"', () => {
  it('不提供一键删除全部语音模型 —— 会连正在用的那个一起端掉', () => {
    const i = SRC.indexOf('const isVoiceModels');
    const block = SRC.slice(i, i + 1200);
    expect(block).not.toMatch(/clearVoiceModels|removeAllModels|clearModels/);
  });

  it('跳到语音设置页, 让用户自己挑删哪个', () => {
    const i = SRC.indexOf('const isVoiceModels');
    const block = SRC.slice(i, i + 1200);
    expect(block).toMatch(/neox:open-settings/);
    expect(block).toMatch(/tab: 'tts'/);
  });
});
