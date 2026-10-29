import chalk from 'chalk';

export function supportsUnicode(): boolean {
  const env = process.env;
  if (env.NEOX_ASCII === '1') return false;
  if (process.platform !== 'win32') return env.TERM !== 'linux' && env.TERM !== 'dumb';
  return Boolean(
    env.WT_SESSION                          // Windows Terminal
    || env.TERMINUS_SUBLIME
    || env.ConEmuTask === '{cmd::Cmder}'
    || env.TERM_PROGRAM === 'Terminus-Sublime'
    || env.TERM_PROGRAM === 'vscode'
    || env.TERM === 'xterm-256color'
    || env.TERM === 'alacritty'
    || env.TERM === 'rxvt-unicode'
    || env.TERM === 'rxvt-unicode-256color'
    || env.TERMINAL_EMULATOR === 'JetBrains-JediTerm',
  );
}

export function colorLevel(): 0 | 1 | 2 | 3 {
  return chalk.level as 0 | 1 | 2 | 3;
}
