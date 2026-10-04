import { describe, it, expect, beforeEach } from 'vitest';
import { ToolAliasRegistry } from '../toolAliasRegistry.js';

describe('ToolAliasRegistry', () => {
  let registry: ToolAliasRegistry;

  beforeEach(() => {
    registry = new ToolAliasRegistry();
  });

  it('resolves builtin aliases', () => {
    registry.buildFromTools([{ name: 'execute_shell' }, { name: 'readfile' }]);
    expect(registry.resolve('bash')).toBe('execute_shell');
    expect(registry.resolve('Bash')).toBe('execute_shell');
    expect(registry.resolve('read')).toBe('readfile');
    expect(registry.resolve('Read')).toBe('readfile');
  });

  it('returns canonical names as-is', () => {
    registry.buildFromTools([{ name: 'execute_shell' }]);
    expect(registry.resolve('execute_shell')).toBe('execute_shell');
  });

  it('returns null for unknown names', () => {
    registry.buildFromTools([{ name: 'execute_shell' }]);
    expect(registry.resolve('totally_unknown')).toBe(null);
  });

  it('uses Tool.aliases field', () => {
    registry.buildFromTools([
      { name: 'my_tool', aliases: ['mt', 'mytool'] },
    ]);
    expect(registry.resolve('mt')).toBe('my_tool');
    expect(registry.resolve('mytool')).toBe('my_tool');
  });

  it('does not override canonical names with aliases', () => {
    registry.buildFromTools([
      { name: 'search' },
      { name: 'find', aliases: ['search'] }, // alias conflicts with canonical
    ]);
    // 'search' is a canonical name, should not be overridden
    expect(registry.resolve('search')).toBe('search');
  });

  it('resolveOrPassthrough returns input for unknowns', () => {
    registry.buildFromTools([]);
    expect(registry.resolveOrPassthrough('unknown_tool')).toBe('unknown_tool');
  });

  it('getAliases returns all aliases for a canonical name', () => {
    registry.buildFromTools([{ name: 'execute_shell' }]);
    const aliases = registry.getAliases('execute_shell');
    expect(aliases).toContain('bash');
    expect(aliases).toContain('Bash');
    expect(aliases).toContain('shell');
  });
});
