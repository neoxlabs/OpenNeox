import { parseDuration } from './runtime.mjs';

const args = process.argv.slice(2);
console.log(parseDuration(args[0] ?? '1m'));
