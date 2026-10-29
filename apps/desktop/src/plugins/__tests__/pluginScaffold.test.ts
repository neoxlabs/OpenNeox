import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { scaffoldPlugin } from '../pluginScaffold.js';

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'neox-scaffold-'));
}

describe('scaffoldPlugin', () => {
  it('rejects invalid names', async () => {
    const dir = await mkTmp();
    const r = await scaffoldPlugin({ name: 'Bad Name', targetDir: dir });
    expect(r.success).toBe(false);
    expect(r.error).toContain('Invalid plugin name');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates basic template', async () => {
    const dir = await mkTmp();
    const r = await scaffoldPlugin({
      name: 'my-basic',
      targetDir: dir,
      force: true,
      description: 'A basic plugin',
    });
    expect(r.success).toBe(true);
    expect(r.created).toContain('plugin.json');
    expect(r.created).toContain('skills/example/SKILL.md');
    expect(r.created).toContain('commands/example.md');
    expect(r.created).toContain('README.md');

    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf-8'));
    expect(manifest.name).toBe('my-basic');
    expect(manifest.description).toBe('A basic plugin');
    expect(manifest.skills).toEqual(['skills']);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates tool template with tools/index.js', async () => {
    const dir = await mkTmp();
    const r = await scaffoldPlugin({ name: 'my-tool', template: 'tool', targetDir: dir, force: true });
    expect(r.success).toBe(true);
    expect(r.created).toContain('tools/index.js');

    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf-8'));
    expect(manifest.tools).toEqual(['tools/index.js']);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates ui-view template with iframe entry', async () => {
    const dir = await mkTmp();
    const r = await scaffoldPlugin({ name: 'my-ui', template: 'ui-view', targetDir: dir, force: true });
    expect(r.success).toBe(true);
    expect(r.created).toContain('ui/index.html');
    expect(r.created).toContain('ui/icon.svg');

    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf-8'));
    expect(manifest.views).toHaveLength(1);
    expect(manifest.views[0].entry).toBe('ui/index.html');
    expect(manifest.views[0].id).toBe('my-ui.main');

    const html = await fs.readFile(path.join(dir, 'ui/index.html'), 'utf-8');
    expect(html).toContain('neox.plugin.resize');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects writing into non-empty target without force', async () => {
    const dir = await mkTmp();
    await fs.writeFile(path.join(dir, 'existing.txt'), 'x');
    const r = await scaffoldPlugin({ name: 'x-plug', targetDir: dir });
    expect(r.success).toBe(false);
    expect(r.error).toContain('not empty');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('overwrites with force', async () => {
    const dir = await mkTmp();
    await fs.writeFile(path.join(dir, 'existing.txt'), 'x');
    const r = await scaffoldPlugin({ name: 'x-plug', targetDir: dir, force: true });
    expect(r.success).toBe(true);
    // existing.txt 保留 (scaffold 不删除)
    const still = await fs.readFile(path.join(dir, 'existing.txt'), 'utf-8');
    expect(still).toBe('x');
    await fs.rm(dir, { recursive: true, force: true });
  });
});
