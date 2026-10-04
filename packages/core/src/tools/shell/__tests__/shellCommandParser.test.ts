import { describe, it, expect } from 'vitest';
import { parseShellCommand, inferCommandTimeout, COMMAND_TIMEOUT_MAP, DEFAULT_TIMEOUT_MS } from '../shellCommandParser.js';

describe('shellCommandParser', () => {
  describe('parseShellCommand', () => {
    it('parses simple command', () => {
      const result = parseShellCommand('ls -la');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].base).toBe('ls');
      expect(result.commands[0].args).toEqual(['-la']);
      expect(result.hasPipeline).toBe(false);
      expect(result.hasSubstitution).toBe(false);
    });

    it('splits command chain with &&', () => {
      const result = parseShellCommand('cd /tmp && ls -la && echo done');
      expect(result.commands).toHaveLength(3);
      expect(result.commands[0].base).toBe('cd');
      expect(result.commands[0].connector).toBe(null);
      expect(result.commands[1].base).toBe('ls');
      expect(result.commands[1].connector).toBe('&&');
      expect(result.commands[2].base).toBe('echo');
      expect(result.commands[2].connector).toBe('&&');
    });

    it('splits pipeline', () => {
      const result = parseShellCommand('cat file.txt | grep pattern | wc -l');
      expect(result.commands).toHaveLength(3);
      expect(result.hasPipeline).toBe(true);
      expect(result.commands[1].connector).toBe('|');
    });

    it('does not split quoted strings', () => {
      const result = parseShellCommand('echo "a && b || c ; d"');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].base).toBe('echo');
    });

    it('does not split single-quoted strings', () => {
      const result = parseShellCommand("echo 'rm -rf / && sudo'");
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].base).toBe('echo');
    });

    it('handles semicolons', () => {
      const result = parseShellCommand('echo a; echo b');
      expect(result.commands).toHaveLength(2);
      expect(result.commands[1].connector).toBe(';');
    });

    it('handles || operator', () => {
      const result = parseShellCommand('test -f file || touch file');
      expect(result.commands).toHaveLength(2);
      expect(result.commands[1].connector).toBe('||');
    });

    it('detects $() substitution', () => {
      const result = parseShellCommand('echo $(date)');
      expect(result.hasSubstitution).toBe(true);
      expect(result.commands[0].hasSubstitution).toBe(true);
    });

    it('detects backtick substitution', () => {
      const result = parseShellCommand('echo `whoami`');
      expect(result.hasSubstitution).toBe(true);
    });

    it('ignores substitution inside single quotes', () => {
      const result = parseShellCommand("echo '$(date)'");
      expect(result.hasSubstitution).toBe(false);
    });

    it('detects redirect', () => {
      const result = parseShellCommand('echo hello > /tmp/out.txt');
      expect(result.commands[0].hasRedirect).toBe(true);
      expect(result.commands[0].redirectTarget).toBe('/tmp/out.txt');
    });

    it('handles escaped characters', () => {
      const result = parseShellCommand('echo hello\\ world');
      expect(result.commands).toHaveLength(1);
    });

    it('handles mixed connectors', () => {
      const result = parseShellCommand('npm install && npm test || echo "failed" ; npm run build | tee log.txt');
      expect(result.commands).toHaveLength(5);
      expect(result.hasPipeline).toBe(true);
    });

    it('handles parenthesized groups (does not split inside)', () => {
      const result = parseShellCommand('(cd /tmp && ls) || echo failed');
      expect(result.commands).toHaveLength(2);
      expect(result.commands[1].connector).toBe('||');
    });
  });

  describe('inferCommandTimeout', () => {
    it('uses fast timeout for ls', () => {
      expect(inferCommandTimeout('ls -la')).toBe(10_000);
    });

    it('uses medium timeout for git', () => {
      expect(inferCommandTimeout('git status')).toBe(60_000);
    });

    it('uses long timeout for npm install', () => {
      expect(inferCommandTimeout('npm install')).toBe(300_000);
    });

    it('uses docker timeout for docker build', () => {
      expect(inferCommandTimeout('docker build .')).toBe(600_000);
    });

    it('takes max timeout in pipeline', () => {
      // cat (10s) | grep (60s) → max = 60s
      expect(inferCommandTimeout('cat file | grep pattern')).toBe(60_000);
    });

    it('takes max timeout in command chain', () => {
      // ls (10s) && npm install (300s) → max = 300s
      expect(inferCommandTimeout('ls && npm install')).toBe(300_000);
    });

    it('defaults to 120s for unknown commands', () => {
      expect(inferCommandTimeout('my-custom-script')).toBe(DEFAULT_TIMEOUT_MS);
    });

    it('handles path-prefixed commands', () => {
      // /usr/bin/git → git → 60s
      expect(inferCommandTimeout('/usr/bin/git status')).toBe(60_000);
    });
  });
});
