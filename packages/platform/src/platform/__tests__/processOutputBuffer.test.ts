import { afterEach, describe, expect, it } from 'vitest';
import { processManager } from '../processManager.js';

const PID = 987_650 + Math.floor(Math.random() * 1000);

afterEach(() => { processManager.untrack(PID); });

function track() {
  processManager.register({ pid: PID, command: 'python3 -m http.server', cwd: '/tmp', background: true });
}

describe('appendOutput 按行拼', () => {
  it('以换行结尾的 chunk 不产生空行', () => {
    track();
    processManager.appendOutput(PID, 'Serving HTTP on :: port 18799\n');
    processManager.appendOutput(PID, 'GET / 200\n');
    processManager.appendOutput(PID, 'GET /nope 404\n');
    expect(processManager.getOutput(PID)).toBe('Serving HTTP on :: port 18799\nGET / 200\nGET /nope 404');
  });

  it('半行 chunk 接到上一行, 不劈成两行', () => {
    track();
    processManager.appendOutput(PID, 'Compil');
    processManager.appendOutput(PID, 'ing...\ndone');
    processManager.appendOutput(PID, '\n');
    expect(processManager.getOutput(PID)).toBe('Compiling...\ndone');
  });

  it('真正的空行保留', () => {
    track();
    processManager.appendOutput(PID, 'a\n\nb\n');
    expect(processManager.getOutput(PID)).toBe('a\n\nb');
  });
});
