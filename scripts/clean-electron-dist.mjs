import { rm } from 'node:fs/promises';

const targets = [
  'apps/cli/dist/ui-electron',
  'apps/cli/dist/cli',
  'apps/cli/dist/server',
];

await Promise.all(targets.map(async (target) => {
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}));
