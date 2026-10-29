#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const notes = JSON.parse(readFileSync(new URL('../notes.json', import.meta.url), 'utf8'));

for (const note of notes) {
  console.log(`${note.done ? '[x]' : '[ ]'} ${note.text} (${note.tag})`);
}
