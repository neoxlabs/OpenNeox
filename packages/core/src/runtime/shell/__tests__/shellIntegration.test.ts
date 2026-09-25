import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectShellKind, installShellIntegration } from '../shellIntegration.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) {
    try { cleanups.pop()!(); } catch { /* ignore */ }
  }
});

describe('detectShellKind', () => {
  it('recognizes common shells from path', () => {
    expect(detectShellKind('/bin/zsh')).toBe('zsh');
    expect(detectShellKind('/usr/local/bin/zsh-5.9')).toBe('zsh');
    expect(detectShellKind('/bin/bash')).toBe('bash');
    expect(detectShellKind('/usr/bin/fish')).toBe('fish');
    expect(detectShellKind('pwsh')).toBe('pwsh');
    expect(detectShellKind('/usr/local/bin/powershell')).toBe('pwsh');
    expect(detectShellKind('/bin/dash')).toBe('unknown');
    expect(detectShellKind('weird-shell')).toBe('unknown');
  });
});

describe('installShellIntegration', () => {
  it('zsh uses ZDOTDIR strategy + writes .zshrc with OSC 133 hooks', () => {
    const r = installShellIntegration({ shell: '/bin/zsh', cleanupOnExit: false });
    cleanups.push(r.cleanup);
    expect(r.kind).toBe('zsh');
    expect(r.shell).toBe('/bin/zsh');
    expect(r.args).toEqual(['-i']);
    expect(r.env.ZDOTDIR).toBe(r.tmpDir);
    const rcContent = fs.readFileSync(path.join(r.tmpDir, '.zshrc'), 'utf-8');
    expect(rcContent).toContain('precmd_functions+=(_neox_precmd)');
    expect(rcContent).toContain('preexec_functions+=(_neox_preexec)');
    expect(rcContent).toContain('133;D');  // exit code marker
    expect(rcContent).toContain('133;A');  // prompt start marker
    expect(rcContent).toContain('133;B');  // prompt end marker
    expect(rcContent).toContain('133;C');  // command start marker
    expect(rcContent).toContain('1337;CurrentDir'); // cwd hook
  });

  it('bash uses --rcfile strategy', () => {
    const r = installShellIntegration({ shell: '/bin/bash', cleanupOnExit: false });
    cleanups.push(r.cleanup);
    expect(r.kind).toBe('bash');
    expect(r.args[0]).toBe('--rcfile');
    expect(r.args[1]).toContain(r.tmpDir);
    expect(r.args).toContain('-i');
    const rcContent = fs.readFileSync(r.args[1], 'utf-8');
    expect(rcContent).toContain("trap '_neox_preexec' DEBUG");
    expect(rcContent).toContain('PROMPT_COMMAND="_neox_precmd');
    expect(rcContent).toContain('133;D');
  });

  it('fish uses --init-command strategy', () => {
    const r = installShellIntegration({ shell: '/usr/bin/fish', cleanupOnExit: false });
    cleanups.push(r.cleanup);
    expect(r.kind).toBe('fish');
    expect(r.args[0]).toBe('--init-command');
    expect(r.args[1]).toContain('source');
    expect(r.args[1]).toContain(r.tmpDir);
    expect(r.args).toContain('-i');
    const initContent = fs.readFileSync(path.join(r.tmpDir, 'init.fish'), 'utf-8');
    expect(initContent).toContain('--on-event fish_postexec');
    expect(initContent).toContain('--on-event fish_preexec');
    expect(initContent).toContain('1337;CurrentDir');
  });

  it('pwsh uses -NoExit -File strategy', () => {
    const r = installShellIntegration({ shell: 'pwsh', cleanupOnExit: false });
    cleanups.push(r.cleanup);
    expect(r.kind).toBe('pwsh');
    expect(r.args[0]).toBe('-NoExit');
    expect(r.args[1]).toBe('-File');
    expect(r.args[2]).toContain(r.tmpDir);
    const psContent = fs.readFileSync(r.args[2], 'utf-8');
    expect(psContent).toContain('function prompt');
    expect(psContent).toContain('133;D');
  });

  it('unknown shell returns empty args + env (no injection)', () => {
    const r = installShellIntegration({ shell: '/bin/dash', cleanupOnExit: false });
    cleanups.push(r.cleanup);
    expect(r.kind).toBe('unknown');
    expect(r.args).toEqual([]);
    expect(r.env).toEqual({});
  });

  it('cleanup removes the tmp directory', () => {
    const r = installShellIntegration({ shell: '/bin/zsh', cleanupOnExit: false });
    expect(fs.existsSync(r.tmpDir)).toBe(true);
    r.cleanup();
    expect(fs.existsSync(r.tmpDir)).toBe(false);
  });

  it('cleanup is idempotent', () => {
    const r = installShellIntegration({ shell: '/bin/zsh', cleanupOnExit: false });
    r.cleanup();
    /* 第二次调用不应抛错 */
    expect(() => r.cleanup()).not.toThrow();
  });
});
