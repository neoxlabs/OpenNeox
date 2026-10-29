import { parseDuration } from './runtime.mjs';

export function readTimeout(config) {
  return Number(config.timeout ?? parseDuration('30s'));
}
