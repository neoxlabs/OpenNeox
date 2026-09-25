
import { createSession, Session } from '@neoxlabs/sdk';

const session = await createSession({
  model: 'claude-sonnet-4-6',
  checkpointDir: './.neox-checkpoints',
  sessionId: 'refactor-auth-2026-04-20',
});

console.log(`Session created: id=${session.id}`);

try {
  await session.send('Start reviewing the auth module');
  console.log('first turn done');

  // 分叉出一个并行 session
  const alt = session.fork();
  console.log(`Forked: ${alt.id}`);

  // 进程挂了之后恢复 (provider 不落盘, 恢复时重新给或走环境变量)
  const resumed = await Session.resume(session.id, {
    checkpointDir: './.neox-checkpoints',
    model: 'claude-sonnet-4-6',
  });
  console.log(`Resumed ${resumed.id} with ${resumed.history().length} messages`);

  await session.close();
} catch (err) {
  console.log(`(expected in v0.0.0-alpha) ${(err as Error).message}`);
}
