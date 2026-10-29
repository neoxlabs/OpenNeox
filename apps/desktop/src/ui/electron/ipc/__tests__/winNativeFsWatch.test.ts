import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

function handleCount(): number {
  const out = execSync(
    `powershell -NoProfile -Command "(Get-Process -Id ${process.pid}).HandleCount"`,
    { encoding: 'utf8' },
  );
  return Number(String(out).trim());
}

describe.skipIf(process.platform !== 'win32')('Windows 原生 fs.watch recursive', () => {
  it('ReadDirectoryChangesW 整树约 1 句柄, 写入看得到', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-fs-watch-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a');
    await new Promise((r) => setTimeout(r, 150));
    const before = handleCount();
    const seen: string[] = [];
    const watcher = fs.watch(root, { recursive: true, persistent: true }, (_type, name) => {
      if (name) seen.push(String(name));
    });
    await new Promise((r) => setTimeout(r, 200));
    const delta = handleCount() - before;
    fs.writeFileSync(path.join(root, 'src', 'probe.ts'), 'ok');
    const deadline = Date.now() + 2000;
    while (!seen.some((n) => n.includes('probe')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    watcher.close();
    fs.rmSync(root, { recursive: true, force: true });
    expect(delta).toBeLessThan(15);
    expect(seen.some((n) => n.includes('probe'))).toBe(true);
  }, 12_000);
});
