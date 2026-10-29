import { parseDuration } from './runtime.mjs';

export function delayFor(spec) {
  return parseDuration(spec);
}
