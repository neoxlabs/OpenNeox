import path from 'node:path';
import fs from 'node:fs';
import {
  listSessions, replaySession, renderReplayMarkdown, eventsDirOf,
} from '@neoxlabs/core/platform/actionLog/index.js';

function usage(): void {
  console.log('Usage: neox audit [sessionId] [options]');
  console.log('');
  console.log('  不给 sessionId  列出这个工作区最近的会话');
  console.log('  给了 sessionId  回放那次会话: 每一轮的提问、模型、工具调用、改过的文件、成败');
  console.log('');
  console.log('Options:');
  console.log('  --workspace <path>   审计哪个工作区 (默认当前目录)');
  console.log('  --json               输出 JSON 而不是 Markdown');
  console.log('  --out <file>         写到文件而不是打印');
  console.log('  --limit <n>          列表最多列几条 (默认 20)');
}

function stamp(ts: number): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-';
}

export async function handleAuditCommand(argv: string[]): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') { usage(); return 0; }

  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const workspace = path.resolve(flag('--workspace') ?? process.cwd());
  const asJson = argv.includes('--json');
  const out = flag('--out');
  const limit = Number(flag('--limit') ?? 20) || 20;
  const sessionId = argv.find((a) => !a.startsWith('--')
    && a !== flag('--workspace') && a !== flag('--out') && a !== flag('--limit'));

  const emit = (text: string): void => {
    if (out) {
      fs.writeFileSync(path.resolve(out), text, 'utf8');
      console.log(`已写入 ${path.resolve(out)}`);
    } else {
      console.log(text);
    }
  };

  if (!sessionId) {
    const items = listSessions(workspace, limit);
    if (asJson) { emit(JSON.stringify(items, null, 2)); return 0; }
    if (items.length === 0) {
      /* 说清楚是"这里没有记录"而不是"命令坏了" —— 这两件事的下一步完全不同 */
      console.log(`这个工作区没有事件记录: ${workspace}`);
      console.log(`(找的是 ${eventsDirOf(workspace)})`);
      console.log('如果你审计的是别的目录, 用 --workspace <path>。');
      return 0;
    }
    console.log(`${workspace} 最近 ${items.length} 个会话:`);
    console.log('');
    for (const s of items) {
      console.log(`  ${s.sessionId}`);
      console.log(`    ${stamp(s.startedAt)} → ${stamp(s.endedAt)} · ${s.runs} 轮 · ${s.files} 个文件`);
      if (s.firstPrompt) console.log(`    ${s.firstPrompt}`);
    }
    console.log('');
    console.log('回放其中一个: neox audit <sessionId>');
    return 0;
  }

  const session = replaySession(workspace, sessionId);
  if (!session) {
    console.log(`没有这个会话的记录: ${sessionId}`);
    console.log(`(找的是 ${eventsDirOf(workspace)}; 不带参数跑一次 neox audit 可以看有哪些)`);
    return 1;
  }
  emit(asJson ? JSON.stringify(session, null, 2) : renderReplayMarkdown(session));
  return 0;
}
