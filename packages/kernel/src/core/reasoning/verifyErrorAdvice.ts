/**
 * verifyErrorAdvice — 验证失败时给模型的最小修复建议 (VERIFY-06)
 *
 * 背景: 验证失败后模型看到的是整段 tsc / go vet 输出, 常见反应是「再跑一遍」或者
 * 「整个文件重写」。真正能省回合的是三件事:
 *   1. 把第一条错误定位到 **文件:行:列**;
 *   2. 按错误码给一句**只改这一行**的建议;
 *   3. 同一个错误反复出现时明说「别再重跑」, 并把次数记下来。
 *
 * 这里只做纯文本解析 + 规则映射, 不碰进程/文件系统 —— 好测, 也不会因为某个语言的
 * 输出格式变了就整个验证挂掉 (解析不到就退回原文, 不影响原有行为)。
 */

export interface ParsedVerifyError {
    /** 输出里给出的文件路径 (可能相对, 也可能带 `../`) */
    file?: string;
    line: number;
    column?: number;
    /** TS2322 / E0425 / SyntaxError ... (拿不到就不填) */
    code?: string;
    message: string;
}

/** 同一错误最多再跑几次 —— 第 3 次出现时明确劝停 (VERIFY-06 验收: 同错重跑 ≤2 次) */
export const MAX_SAME_ERROR_RERUNS = 2;

/* tsc --pretty false: `src/a.ts(2,7): error TS2322: Type ...` */
const TSC_RE = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/;
/* go vet / rustc short: `./main.go:7:2: undefined: foo` / `src/main.rs:7:5: error[E0425]: ...` */
const FILE_LINE_RE = /^(.+?):(\d+)(?::(\d+))?:\s*(?:error(?:\[[^\]]+\])?\s*:?\s*)?(.+)$/i;
/* python: `  File "x.py", line 3` + 下一行的 SyntaxError */
const PY_FILE_RE = /^\s*File "(.+?)", line (\d+)/;
const PY_ERROR_RE = /^\s*(\w*(?:Error|Exception)):\s*(.+)$/;

/**
 * 从验证输出里挑出第一条可定位的错误。
 * 解析不出来返回 null —— 调用方保持原样把输出交给模型。
 */
export function parseFirstVerifyError(output: string): ParsedVerifyError | null {
    const lines = output.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.trim()) continue;

        const tsc = TSC_RE.exec(line);
        if (tsc) {
            return { file: tsc[1], line: Number(tsc[2]), column: Number(tsc[3]), code: tsc[4], message: tsc[5].trim() };
        }

        const py = PY_FILE_RE.exec(line);
        if (py) {
            /* SyntaxError 一般在下一行; 找不到就把文件名那行当 message */
            const errLine = lines.slice(i + 1).find((l) => PY_ERROR_RE.test(l));
            const errMatch = errLine ? PY_ERROR_RE.exec(errLine) : null;
            return {
                file: py[1],
                line: Number(py[2]),
                code: errMatch?.[1],
                message: errMatch ? errMatch[2].trim() : line.trim(),
            };
        }

        /* 只认带行号的错误行 —— 普通日志行 (`npm ERR!` 之类) 不当作可定位错误 */
        const fl = FILE_LINE_RE.exec(line);
        if (fl && !/^\s*at\s/.test(line)) {
            const message = fl[4].trim();
            if (!message) continue;
            return {
                file: fl[1],
                line: Number(fl[2]),
                column: fl[3] ? Number(fl[3]) : undefined,
                message,
            };
        }
    }

    return null;
}

/**
 * 按错误码/错误文案给一句**只改这一行**的建议。
 * 宁可泛一点, 也不要说错 —— 规则没命中时给通用建议。
 */
export function buildMinimalFixAdvice(err: ParsedVerifyError): string {
    const where = `第 ${err.line} 行${err.column ? ` 第 ${err.column} 列` : ''}`;
    const code = (err.code || '').toUpperCase();
    const msg = err.message;

    const known = ((): string | null => {
        if (code === 'TS2304' || code === 'TS2552') {
            const name = /Cannot find name '([^']+)'/.exec(msg)?.[1];
            return `找不到${name ? ` \`${name}\`` : '这个名字'} —— 检查拼写, 或补上 import / 声明。`;
        }
        if (code === 'TS2339') {
            const prop = /Property '([^']+)' does not exist on type '([^']+)'/.exec(msg);
            return prop
                ? `\`${prop[2]}\` 上没有 \`${prop[1]}\` —— 核对属性名, 或先在类型定义里补上它。`
                : '访问了类型上不存在的属性 —— 核对属性名或补类型定义。';
        }
        if (code === 'TS2322') {
            return '类型对不上 —— 把值改成目标类型, 或显式转换 / 改类型标注。';
        }
        if (code === 'TS2345') {
            return '实参类型和函数签名不一致 —— 按签名改实参, 或补类型收窄。';
        }
        if (code === 'TS2554') {
            const n = /Expected (\d+) arguments?, but got (\d+)/.exec(msg);
            return n ? `参数个数不对 (要 ${n[1]} 个, 给了 ${n[2]} 个) —— 补齐或删掉多余实参。` : '参数个数不对 —— 对照函数签名补齐。';
        }
        if (code === 'TS7006') {
            const p = /Parameter '([^']+)' implicitly has an 'any' type/.exec(msg)?.[1];
            return `参数${p ? ` \`${p}\`` : ''}缺类型标注 —— 补一个具体类型。`;
        }
        if (code === 'TS1005' || code === 'TS1109' || code === 'TS1128' || code === 'TS1136') {
            return '语法错误 —— 看这一行前后的括号 / 逗号 / 引号是否配对。';
        }
        if (code === 'TS2307') {
            const mod = /Cannot find module '([^']+)'/.exec(msg)?.[1];
            return `找不到模块${mod ? ` \`${mod}\`` : ''} —— 核对导入路径, 或确认依赖已安装。`;
        }
        if (code === 'TS18046') {
            return '值还是 unknown —— 先用 typeof / instanceof / 断言做类型收窄。';
        }
        if (code === 'TS2531' || code === 'TS18047' || code === 'TS18048') {
            return '这里可能为空 —— 先判空, 或用可选链 / 非空断言。';
        }
        if (/^E\d{4}$/.test(code) || /error\[E\d+\]/.test(msg)) {
            return 'Rust 编译错误 —— 按报错改这一处的类型 / 借用, 不要整文件重写。';
        }
        if (/syntaxerror/i.test(code) || /SyntaxError/.test(msg)) {
            return '语法错误 —— 看这一行附近的缩进 / 括号 / 冒号。';
        }
        if (/undefined: /.test(msg)) {
            return '引用了未定义的标识符 —— 检查拼写或补 import / 声明。';
        }
        return null;
    })();

    const fix = known ?? `按这条报错改这一处: ${msg.slice(0, 160)}`;
    return `${where}: ${fix}`;
}

/**
 * 错误签名 —— 用来识别「同一个错又出现了」。
 * 只取第一条错误 + 规范化空白, 行号也纳入: 行号变了说明改到了别处。
 */
export function verifyErrorSignature(output: string): string | null {
    const err = parseFirstVerifyError(output);
    if (err) {
        const message = err.message.replace(/\s+/g, ' ').trim().slice(0, 120);
        return `${err.code ?? 'ERR'}:${err.line}:${message}`;
    }
    const first = output.split('\n').map((l) => l.trim()).find(Boolean);
    return first ? first.slice(0, 160) : null;
}

/** 同一错误出现次数记账 (每个 AutoVerifyPipeline 实例一份) */
export class RepeatErrorTracker {
    private counts = new Map<string, number>();

    /** 记一次, 返回含本次的累计次数 */
    record(signature: string | null): number {
        if (!signature) return 0;
        const n = (this.counts.get(signature) ?? 0) + 1;
        this.counts.set(signature, n);
        return n;
    }

    count(signature: string | null): number {
        return signature ? (this.counts.get(signature) ?? 0) : 0;
    }

    reset(): void {
        this.counts.clear();
    }
}

/** 重复次数超过上限时追加的那句话 (没超返回空串) */
export function repeatWarning(count: number): string {
    if (count <= MAX_SAME_ERROR_RERUNS) return '';
    return `同一错误已经出现 ${count} 次, 别再重跑全量验证 —— 先改上面那一行。`;
}
