import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assert,
  assertCommandPass,
  assertUntampered,
  runCheck,
  sha256File,
  workdirFromArgv,
} from '../../lib/check-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_HASH = sha256File(path.join(HERE, 'fixture/calc/stats_test.go'));

const HIDDEN_SOURCE = `package calc

import "testing"

func TestHiddenBench(t *testing.T) {
	if got := Mean([]int{1, 2, 3}); got != 2 {
		t.Fatalf("Mean([1 2 3]) = %v, want 2", got)
	}
	if got := Mean([]int{0, 5}); got != 2.5 {
		t.Fatalf("Mean([0 5]) = %v, want 2.5", got)
	}
	if got := Median([]int{10, 2, 8, 4}); got != 6 {
		t.Fatalf("Median([10 2 8 4]) = %v, want 6", got)
	}
}
`;

runCheck(async () => {
  const workdir = workdirFromArgv();
  assertUntampered(workdir, 'calc/stats_test.go', TEST_HASH);
  assertCommandPass('go', ['test', './...'], { cwd: workdir, timeoutMs: 180_000 }, 'Go 测试');

  const hiddenPath = path.join(workdir, 'calc/hidden_bench_test.go');
  fs.writeFileSync(hiddenPath, HIDDEN_SOURCE);
  try {
    const out = assertCommandPass(
      'go',
      ['test', './calc', '-run', 'TestHiddenBench', '-v'],
      { cwd: workdir, timeoutMs: 180_000 },
      '隐藏测试',
    );
    assert(out.includes('PASS') || out.includes('ok'), '隐藏测试没有通过输出');
  } finally {
    fs.rmSync(hiddenPath, { force: true });
  }
});
