import { drain } from './queue.mjs';
import { loadState } from './store.mjs';

const tasks = loadState();
await drain(tasks);
console.log('done');
