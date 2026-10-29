/**
 * `kill <pid>` through the shell is the agent stopping its own process on purpose.
 * In a CLI trial the agent restarted its dev server this way before every build, and each exit
 * woke a paid turn that said "that was the process I stopped, ignore it".
 */
import { describe, it, expect } from 'vitest';
import { pidsKilledByCommand } from '../executeShellTool.js';

describe('pidsKilledByCommand', () => {
  it.each([
    ['kill 7534', [7534]],
    ['kill -9 7534 7535', [7534, 7535]],
    ['kill -s TERM 7534', [7534]],
    ['kill 7534 && sleep 1 && npm --prefix server run build', [7534]],
    ['cd server; kill -TERM 16781', [16781]],
  ])('%s', (cmd, expected) => {
    expect(pidsKilledByCommand(cmd)).toEqual(expected);
  });

  it.each([
    'kill $(lsof -t -i:3000)',
    'npm run build',
    'echo kill 123 later',
    'pkill -f nest',
    'kill -l',
  ])('ignores %s', (cmd) => {
    expect(pidsKilledByCommand(cmd)).toEqual([]);
  });
});
