export function formatLine(text, options = {}) {
  const prefix = options.prefix ?? '';
  return `${prefix}${text}\n`;
}

export function parseArgs(argv) {
  const options = { prefix: '', text: '' };
  for (const arg of argv) {
    if (arg.startsWith('--prefix=')) options.prefix = arg.slice('--prefix='.length);
    else options.text = options.text ? `${options.text} ${arg}` : arg;
  }
  return options;
}
