/**
 * CLI Output Utilities
 *
 * Provides functions for outputting to the terminal that bypass
 * the console.log interception in debug mode.
 */

export function cliPrintln(line: string): void {
  process.stdout.write(line + '\n');
}

export function cliErrorln(line: string): void {
  process.stderr.write(line + '\n');
}

export function cliPrintlnClear(line: string): void {
  process.stdout.write('\r\x1b[2K' + line + '\n');
}

export function cliPrint(text: string): void {
  process.stdout.write(text);
}

export function cliPrintLines(lines: string[]): void {
  for (const line of lines) {
    process.stdout.write(line + '\n');
  }
}

export function cliPrintEmpty(): void {
  process.stdout.write('\n');
}
