import { describe, it, expect } from 'vitest';
import { validateManifest, checkRuntimePermission, satisfiesNeoxEngine, checkNeoxEngine } from '../pluginSecurity.js';

describe('validateManifest', () => {
  const validManifest = {
    name: 'my-plugin',
    version: '1.0.0',
    description: 'A test plugin',
    author: { name: 'Test Author' },
  };

  it('accepts valid manifest', () => {
    const result = validateManifest(validManifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects missing name', () => {
    const result = validateManifest({ ...validManifest, name: undefined });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('name'))).toBe(true);
  });

  it('rejects invalid name format', () => {
    expect(validateManifest({ ...validManifest, name: 'My Plugin' }).valid).toBe(false);
    expect(validateManifest({ ...validManifest, name: 'UPPERCASE' }).valid).toBe(false);
    expect(validateManifest({ ...validManifest, name: 'a'.repeat(65) }).valid).toBe(false);
  });

  it('rejects reserved name prefixes', () => {
    expect(validateManifest({ ...validManifest, name: 'neox-official-something' }).valid).toBe(false);
    expect(validateManifest({ ...validManifest, name: 'private-repo-test' }).valid).toBe(false);
  });

  it('rejects invalid version', () => {
    expect(validateManifest({ ...validManifest, version: 'abc' }).valid).toBe(false);
    expect(validateManifest({ ...validManifest, version: '1.0' }).valid).toBe(false);
  });

  it('accepts valid semver', () => {
    expect(validateManifest({ ...validManifest, version: '1.0.0' }).valid).toBe(true);
    expect(validateManifest({ ...validManifest, version: '0.1.0-beta.1' }).valid).toBe(true);
  });

  it('rejects missing description', () => {
    const result = validateManifest({ ...validManifest, description: undefined });
    expect(result.valid).toBe(false);
  });

  it('rejects missing author', () => {
    const result = validateManifest({ ...validManifest, author: {} });
    expect(result.valid).toBe(false);
  });

  it('rejects absolute paths in component arrays', () => {
    const result = validateManifest({ ...validManifest, skills: ['/etc/evil'] });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('absolute'))).toBe(true);
  });

  it('rejects parent paths in component arrays', () => {
    const result = validateManifest({ ...validManifest, tools: ['../../escape'] });
    expect(result.valid).toBe(false);
  });

  it('rejects overly broad write permissions', () => {
    const result = validateManifest({
      ...validManifest,
      permissions: { filesystem: { write: ['/'] } },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validateManifest(null).valid).toBe(false);
    expect(validateManifest('string').valid).toBe(false);
  });
});

describe('checkRuntimePermission', () => {
  const manifest = {
    name: 'test',
    version: '1.0.0',
    description: 'test',
    author: { name: 'test' },
    permissions: {
      tools: ['execute_shell', 'readfile'],
      network: true,
      filesystem: {
        read: ['*'],
        write: ['/tmp/test/**'],
      },
    },
  };

  it('allows declared tools', () => {
    expect(checkRuntimePermission(manifest, { type: 'tool', toolName: 'execute_shell' })).toBe(true);
    expect(checkRuntimePermission(manifest, { type: 'tool', toolName: 'readfile' })).toBe(true);
  });

  it('denies undeclared tools', () => {
    expect(checkRuntimePermission(manifest, { type: 'tool', toolName: 'delete_file' })).toBe(false);
  });

  it('allows network when declared', () => {
    expect(checkRuntimePermission(manifest, { type: 'network' })).toBe(true);
  });

  it('denies network when not declared', () => {
    const noNet = { ...manifest, permissions: { ...manifest.permissions, network: false } };
    expect(checkRuntimePermission(noNet, { type: 'network' })).toBe(false);
  });

  it('allows filesystem read with wildcard', () => {
    expect(checkRuntimePermission(manifest, { type: 'filesystem', path: '/any/path', mode: 'read' })).toBe(true);
  });

  it('allows filesystem write within declared scope', () => {
    expect(checkRuntimePermission(manifest, { type: 'filesystem', path: '/tmp/test/file.txt', mode: 'write' })).toBe(true);
  });

  it('denies filesystem write outside scope', () => {
    expect(checkRuntimePermission(manifest, { type: 'filesystem', path: '/etc/passwd', mode: 'write' })).toBe(false);
  });

  it('denies all when no permissions declared', () => {
    const noPerms = { ...manifest, permissions: undefined };
    expect(checkRuntimePermission(noPerms, { type: 'tool', toolName: 'anything' })).toBe(false);
    expect(checkRuntimePermission(noPerms, { type: 'network' })).toBe(false);
  });
});

describe('satisfiesNeoxEngine', () => {
  it('认 >= 和精确版本', () => {
    expect(satisfiesNeoxEngine('3.7.0', '>=3.7.0')).toBe(true);
    expect(satisfiesNeoxEngine('3.7.1', '>=3.7.0')).toBe(true);
    expect(satisfiesNeoxEngine('3.6.9', '>=3.7.0')).toBe(false);
    expect(satisfiesNeoxEngine('3.7.0', '3.7.0')).toBe(true);
  });

  it('> 不含等于', () => {
    expect(satisfiesNeoxEngine('3.7.0', '>3.7.0')).toBe(false);
    expect(satisfiesNeoxEngine('3.7.1', '>3.7.0')).toBe(true);
  });

  it('解析不了的范围一律不满足', () => {
    expect(satisfiesNeoxEngine('3.7.0', '^3.7.0')).toBe(false);
    expect(satisfiesNeoxEngine('3.7.0', '>=3.7')).toBe(false);
  });
});

describe('checkNeoxEngine', () => {
  it('没有 engines 就放行', () => {
    expect(checkNeoxEngine({}).ok).toBe(true);
  });

  it('有当前版本且不够就硬拒', () => {
    const r = checkNeoxEngine({ engines: { neox: '>=3.7.0' } }, { neoxVersion: '3.6.9' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('3.6.9');
  });

  it('够版本就过', () => {
    expect(checkNeoxEngine({ engines: { neox: '>=3.7.0' } }, { neoxVersion: '3.7.0' }).ok).toBe(true);
  });

  it('没带版本只警告, 不挡打包机 / 开发装', () => {
    const r = checkNeoxEngine({ engines: { neox: '>=3.7.0' } });
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('写了认不出的范围就拒', () => {
    const r = checkNeoxEngine({ engines: { neox: '^3.7.0' } }, { neoxVersion: '3.7.0' });
    expect(r.ok).toBe(false);
  });
});
