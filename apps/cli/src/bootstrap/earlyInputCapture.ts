/** 在主模块加载期间缓存管道 stdin，使后续 REPL 或 print 模式可以读取。 */

let capturing = false;
const capturedChunks: Buffer[] = [];
let dataHandler: ((chunk: Buffer) => void) | null = null;

/**
 * 开始捕获 stdin — 在主模块 import 前调用
 */
export function startCapturingEarlyInput(): void {
  if (capturing) return;
  if (!process.stdin || process.stdin.destroyed) return;

  if (process.stdin.isTTY) {
    startTtyTypeahead();
    return;
  }

  capturing = true;
  dataHandler = (chunk: Buffer) => {
    capturedChunks.push(chunk);
  };

  process.stdin.on('data', dataHandler);

  // 确保不阻止进程退出
  process.stdin.unref?.();
}

/**
 * 停止捕获并返回已捕获的数据
 */
export function stopCapturingEarlyInput(): Buffer | null {
  if (!capturing) return null;
  capturing = false;

  if (dataHandler) {
    process.stdin.off('data', dataHandler);
    dataHandler = null;
  }

  if (capturedChunks.length === 0) return null;

  const combined = Buffer.concat(capturedChunks);
  capturedChunks.length = 0;
  return combined;
}

/**
 * 获取已捕获的数据（不停止捕获）
 */
export function getCapturedInput(): Buffer | null {
  if (capturedChunks.length === 0) return null;
  return Buffer.concat(capturedChunks);
}

/** 是否正在捕获 */
export function isCapturing(): boolean {
  return capturing;
}

let ttyChunks: Buffer[] = [];
let ttyHandler: ((chunk: Buffer) => void) | null = null;
let ttyTypeahead = '';

/** 带值的选项: 它们后面那个参数不算 "位置参数" */
const VALUE_FLAGS = new Set(['-m', '--model', '--provider', '-d', '--dir', '--timeout', '--output-schema']);

function argsEnterRepl(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (['-p', '--print', '-h', '--help', '-v', '--version', '--json'].includes(a)) return false;
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (!a.startsWith('-')) {
      /* -r / --resume 后面可带会话 id */
      const prev = argv[i - 1];
      if (prev === '-r' || prev === '--resume') continue;
      return false;
    }
  }
  return true;
}

function startTtyTypeahead(): void {
  if (ttyHandler || !argsEnterRepl(process.argv.slice(2))) return;
  const stdin = process.stdin as NodeJS.ReadStream;
  if (typeof stdin.setRawMode !== 'function') return;
  try { stdin.setRawMode(true); } catch { return; }
  ttyHandler = (chunk: Buffer) => {
    /* raw 模式下 Ctrl+C 不再产生 SIGINT —— 这段时间里按 Ctrl+C 就是想退出 */
    if (chunk.includes(0x03)) {
      try { stdin.setRawMode(false); } catch { /* */ }
      process.exit(130);
    }
    ttyChunks.push(chunk);
  };
  stdin.on('data', ttyHandler);
  stdin.unref?.();
}

export function finishTtyTypeahead(): void {
  if (!ttyHandler) return;
  const stdin = process.stdin as NodeJS.ReadStream;
  stdin.off('data', ttyHandler);
  ttyHandler = null;
  /* 不切回 cooked: 之后还没读走的按键留在内核里, 由 Ink (马上再设 raw) 当普通按键读;
   * 中途切 cooked 的话这些字节会被行规程扣到回车为止。退出时各退出处理会复位 raw。 */
  try { stdin.pause(); } catch { /* */ }
  const raw = Buffer.concat(ttyChunks).toString('utf8');
  ttyChunks = [];
  let text = '';
  /* 去掉转义序列 (方向键 / 终端对 OSC 11 背景色查询的应答), 退格删一个字,
   * 其余控制字符 (含回车) 丢掉 —— 不替用户提交 */
  const cleaned = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1bO[A-Za-z]|\x1b./g, '');
  for (const ch of cleaned) {
    if (ch === '\x7f' || ch === '\b') text = [...text].slice(0, -1).join('');
    else if (ch >= ' ') text += ch;
  }
  ttyTypeahead = text;
}

/** 取走预输入 (只能取一次) */
export function takeTtyTypeahead(): string {
  const t = ttyTypeahead;
  ttyTypeahead = '';
  return t;
}
