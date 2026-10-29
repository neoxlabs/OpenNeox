import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { STATE_FILE } from './config.mjs';

export function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')).tasks;
  } catch {
    return [];
  }
}

export function saveState(tasks) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ tasks }, null, 2));
}
