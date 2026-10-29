import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadProjectInstructions } from '../projectInstructions.js';

describe('loadProjectInstructions · .neox/INSTRUCTIONS.md 与共用说明叠加', () => {
  it('Neox 私有说明和共用说明都加载; 共用那几份之间仍只取第一个', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-instr-'));
    fs.mkdirSync(path.join(ws, '.neox'));
    fs.writeFileSync(path.join(ws, '.neox', 'INSTRUCTIONS.md'), 'NEOX_PRIVATE');
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'AGENTS_SHARED');
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), 'CLAUDE_SHARED');
    const r = await loadProjectInstructions(ws);
    expect(r.content).toContain('NEOX_PRIVATE');
    expect(r.content).toContain('AGENTS_SHARED');
    expect(r.content).not.toContain('CLAUDE_SHARED');
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
