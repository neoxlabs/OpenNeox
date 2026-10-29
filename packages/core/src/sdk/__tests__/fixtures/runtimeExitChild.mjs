
const mode = process.env.EXIT_FIXTURE_MODE || 'sleep';

if (mode === 'ok') process.exit(0);
if (mode === 'code') process.exit(134);
/* 被信号带走: 父进程侧拿到 code=0 + signal=SIGKILL */
if (mode === 'signal') process.kill(process.pid, 'SIGKILL');

/* sleep: 等父进程 terminate() */
setInterval(() => {}, 1000);
