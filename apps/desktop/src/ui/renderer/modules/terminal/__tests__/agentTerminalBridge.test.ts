import { describe, it, expect } from 'vitest';
import {
  wrapCommand, matchDone, stripMarker, doneMarker,
  buildPromptHook, matchOscDone, stripOsc,
} from '../agentTerminalBridge';

/* 这几条决定 agent 会不会**永远等下去**。
 * 旧实现靠"命令发出 100ms 后写一句 exit 杀 shell"来判定结束; 现在靠 sentinel。
 * sentinel 认错一次 = 一条命令挂住整个 agent, 所以每种情形都要有闸。 */
const RID = 'terminal-req-123-abc';

describe('agentTerminalBridge', () => {
  it('包出来的命令用 ; 不用 && —— 失败的命令也要打标记', () => {
    const wrapped = wrapCommand('false', RID);
    expect(wrapped).toContain('false\n');
    expect(wrapped).toContain(doneMarker(RID));
    /* && 会让失败的命令永远等不到结束 */
    expect(wrapped).not.toContain('&&');
  });

  it('还没跑完 → null', () => {
    expect(matchDone('正在编译…\n', RID)).toBeNull();
    expect(matchDone('', RID)).toBeNull();
  });

  it('跑完 → 拿到退出码', () => {
    expect(matchDone(`hello\n${doneMarker(RID)}0\n`, RID)).toEqual({ exitCode: 0 });
    expect(matchDone(`boom\n${doneMarker(RID)}127\n`, RID)).toEqual({ exitCode: 127 });
  });

  /* shell 会把我们写进去的那一行**原样回显**一遍。那一次里 %s 还没被替换,
   * 要是把它认成结束, 命令刚发出去就被判定跑完了 —— agent 会拿到一份空输出。 */
  it('不把 shell 的命令回显认成结束', () => {
    const echoed = `$ npm test\nprintf '\\n${doneMarker(RID)}%s\\n' "$?"\n`;
    expect(matchDone(echoed, RID)).toBeNull();
  });

  it('别的 requestId 的标记不算数 (同一个 tab 连着跑两条)', () => {
    const other = `__NEOX_DONE_terminal-req-999-zzz__0\n`;
    expect(matchDone(other, RID)).toBeNull();
  });

  /* fish/nu 不认 $?: 标记打印出来但后面没数字。命令确实结束了, 退出码取不到就当 0 —— 不猜。 */
  it('shell 不认 $? 时仍判为结束, 退出码当 0', () => {
    expect(matchDone(`done\n${doneMarker(RID)}\n`, RID)).toEqual({ exitCode: 0 });
  });

  it('给 agent 的输出里不留 sentinel 脚手架', () => {
    const raw = `line1\nline2\n${doneMarker(RID)}0\n`;
    const out = stripMarker(raw, RID);
    expect(out).toContain('line1');
    expect(out).toContain('line2');
    expect(out).not.toContain('NEOX_DONE');
  });

  it('命令回显那一行也摘掉', () => {
    const raw = `printf '\\n${doneMarker(RID)}%s\\n' "$?"\nreal output\n${doneMarker(RID)}0\n`;
    const out = stripMarker(raw, RID);
    expect(out).toContain('real output');
    expect(out).not.toContain('NEOX_DONE');
    expect(out).not.toContain('printf');
  });
});

describe('agentTerminalBridge - 干净模式', () => {
  /* 真实 PTY 数据里 OSC 是 ESC ] … BEL, 所以断言必须用**带控制字符**的串。
   * 第一版测试用了不带 ESC/BEL 的字符串, 三条全红 —— 测试写得比实现还乐观。 */
  const osc = (code: string) => `\u001b]633;NeoxDone;${code}\u0007`;

  it('注入语句同时覆盖 zsh 和 bash', () => {
    const hook = buildPromptHook();
    expect(hook).toContain('precmd()');           // zsh
    expect(hook).toContain('PROMPT_COMMAND=');    // bash
    expect(hook).toContain('633;NeoxDone;');
    expect(hook.endsWith('\n')).toBe(true);       // 不带换行 shell 不会执行
  });

  it('注入语句的单引号是配平的 (踩过: PROMPT_COMMAND 里嵌单引号把语句劈开)', () => {
    const hook = buildPromptHook();
    const quotes = (hook.match(/'/g) || []).length;
    expect(quotes % 2).toBe(0);
    /* PROMPT_COMMAND 只能赋一个**函数名**, 不能直接塞带引号的命令 */
    expect(hook).toMatch(/PROMPT_COMMAND=[A-Za-z_][A-Za-z0-9_]*\s*$|PROMPT_COMMAND=[A-Za-z_][A-Za-z0-9_]*\n/);
    expect(hook).not.toMatch(/PROMPT_COMMAND='.*'.*'/);
  });

  it('往用户 shell 里塞的函数名带前缀, 不占用可能撞名的短名字', () => {
    expect(buildPromptHook()).toContain('__neox_done');
  });

  it('没有标记 -> 还没跑完', () => {
    expect(matchOscDone('compiling...')).toBeNull();
    expect(matchOscDone('')).toBeNull();
  });

  it('认得出退出码', () => {
    expect(matchOscDone('out' + osc('0'))).toEqual({ exitCode: 0 });
    expect(matchOscDone('out' + osc('130'))).toEqual({ exitCode: 130 });
  });

  /* PTY 数据是分片来的, 半截序列不能判成跑完 —— 否则 agent 拿到一份截断的输出 */
  it('只收到半截 (还没 BEL) 不算跑完', () => {
    expect(matchOscDone('out\u001b]633;NeoxDone;12')).toBeNull();
  });

  it('取最后一个标记 - 同一个 tab 连着跑时前面的不算', () => {
    expect(matchOscDone('a' + osc('0') + 'b' + osc('3'))).toEqual({ exitCode: 3 });
  });

  it('OSC 标记不留在给 agent 的输出里', () => {
    const out = stripOsc('hello' + osc('0') + 'world');
    expect(out).not.toContain('NeoxDone');
    expect(out).toBe('helloworld');
  });
});
