/**
 * TsServerBridge —— Electron main 进程里的 TypeScript Language Server 桥。
 *
 * 用 tsserver（TypeScript 自带的语言服务进程）提供真正的语义分析：
 *   - references（真实引用，不是文本搜索）
 *   - definition（跨文件跳转定义）
 *   - quickinfo（类型信息 hover）
 *   - completions（类型感知补全）
 *
 * 为什么用 tsserver 而不是 typescript-language-server：
 *   - tsserver 是 TypeScript 自带的，不需要额外安装
 *   - 它就是 VSCode / IDEA 底层调用的同一个引擎
 *   - 协议简单（JSON 行协议），不需要完整的 LSP 实现
 *
 * 通信协议
 * --------
 * tsserver 通过 stdin/stdout 通信，每个请求/响应是一行 JSON。
 * 请求格式：{"seq":N,"type":"request","command":"...","arguments":{...}}
 * 响应格式：{"seq":N,"type":"response","command":"...","body":{...}}
 */

import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { createInterface, type Interface } from 'readline';

export interface TsServerReference {
  file: string;
  line: number;       // 1-based
  offset: number;     // 1-based (column)
  lineText?: string;  // 该行的代码内容
  isDefinition?: boolean;
}

export interface TsServerQuickInfo {
  kind: string;
  kindModifiers: string;
  displayString: string;
  documentation: string;
}

export class TsServerBridge {
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private seq = 0;
  private pending = new Map<number, {
    resolve: (body: any) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private openFiles = new Set<string>();
  private workspaceRoot: string | null = null;

  /**
   * 启动 tsserver 子进程。
   */
  async start(workspaceRoot: string): Promise<void> {
    if (this.process) return;
    this.workspaceRoot = workspaceRoot;

    const tsserverPath = join(workspaceRoot, 'node_modules/typescript/lib/tsserver.js');

    this.process = spawn('node', [tsserverPath, '--useSingleInferredProject', '--locale', 'en'], {
      cwd: workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TSS_LOG: '' },
    });

    this.readline = createInterface({ input: this.process.stdout! });

    this.readline.on('line', (line) => {
      // tsserver 输出格式：Content-Length 头 + 空行 + JSON body
      // 或者直接 JSON（在 --useSingleInferredProject 模式下）
      if (!line.startsWith('{')) return;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'response' && msg.request_seq !== undefined) {
          const p = this.pending.get(msg.request_seq);
          if (p) {
            this.pending.delete(msg.request_seq);
            clearTimeout(p.timeout);
            if (msg.success) {
              p.resolve(msg.body);
            } else {
              p.reject(new Error(msg.message || 'tsserver error'));
            }
          }
        }
      } catch {
        // 忽略非 JSON 行
      }
    });

    this.process.stderr?.on('data', (data) => {
      // tsserver 的日志输出，可以忽略
      const text = data.toString().trim();
      if (text && !text.startsWith('Info')) {
        console.warn('[tsserver]', text);
      }
    });

    this.process.on('exit', (code) => {
      console.log(`[tsserver] exited with code ${code}`);
      this.process = null;
      this.readline = null;
      // 清理所有 pending 请求
      for (const [, p] of this.pending) {
        clearTimeout(p.timeout);
        p.reject(new Error('tsserver exited'));
      }
      this.pending.clear();
    });

    // 等 tsserver 启动就绪（发一个 configure 请求）
    await this.request('configure', {
      hostInfo: 'neox-editor',
      preferences: {
        providePrefixAndSuffixTextForRename: true,
      },
    });
  }

  /**
   * 停止 tsserver。
   */
  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.readline = null;
    this.openFiles.clear();
  }

  /**
   * 确保文件已在 tsserver 中打开（tsserver 需要先 open 才能查询）。
   */
  async ensureFileOpen(filePath: string): Promise<void> {
    if (this.openFiles.has(filePath)) return;
    await this.request('open', { file: filePath });
    this.openFiles.add(filePath);
  }

  // --------------------------------------------------------------------------
  // 语义查询 API
  // --------------------------------------------------------------------------

  /**
   * 查找真实引用 —— 这是替代文本搜索的核心 API。
   * 返回的是经过类型系统解析的精确引用，不是按名字搜的。
   */
  async findReferences(filePath: string, line: number, offset: number): Promise<TsServerReference[]> {
    await this.ensureFileOpen(filePath);
    try {
      const body = await this.request('references', { file: filePath, line, offset });
      if (!body?.refs) return [];
      return body.refs.map((ref: any) => ({
        file: ref.file,
        line: ref.start.line,
        offset: ref.start.offset,
        lineText: ref.lineText,
        isDefinition: ref.isDefinition,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 跳转定义 —— 类型系统级别的精确定义位置。
   */
  async findDefinition(filePath: string, line: number, offset: number): Promise<TsServerReference[]> {
    await this.ensureFileOpen(filePath);
    try {
      const body = await this.request('definition', { file: filePath, line, offset });
      if (!Array.isArray(body)) return [];
      return body.map((def: any) => ({
        file: def.file,
        line: def.start.line,
        offset: def.start.offset,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 快速信息 —— 类型 / 文档 / 种类。
   */
  async quickInfo(filePath: string, line: number, offset: number): Promise<TsServerQuickInfo | null> {
    await this.ensureFileOpen(filePath);
    try {
      const body = await this.request('quickinfo', { file: filePath, line, offset });
      if (!body) return null;
      return {
        kind: body.kind || '',
        kindModifiers: body.kindModifiers || '',
        displayString: body.displayString || '',
        documentation: body.documentation || '',
      };
    } catch {
      return null;
    }
  }

  /**
   * 文件内容更新 —— 编辑器内容变化时通知 tsserver。
   */
  async updateFileContent(filePath: string, content: string): Promise<void> {
    if (!this.openFiles.has(filePath)) {
      await this.request('open', { file: filePath, fileContent: content });
      this.openFiles.add(filePath);
    } else {
      await this.request('open', { file: filePath, fileContent: content });
    }
  }

  // --------------------------------------------------------------------------
  // 底层通信
  // --------------------------------------------------------------------------

  private request(command: string, args: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('tsserver not running'));
        return;
      }

      const seq = ++this.seq;
      const msg = JSON.stringify({ seq, type: 'request', command, arguments: args });

      const timeout = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`tsserver timeout: ${command}`));
      }, 10000);

      this.pending.set(seq, { resolve, reject, timeout });

      try {
        const ok = this.process.stdin.write(msg + '\n', (err) => {
          if (err) {
            const entry = this.pending.get(seq);
            if (entry) {
              clearTimeout(entry.timeout);
              this.pending.delete(seq);
              reject(new Error(`tsserver stdin write failed: ${err.message}`));
            }
          }
        });
        if (!ok) {
          /* backpressure — buffer 满了, 不阻塞但 log 一下方便诊断 */
          // eslint-disable-next-line no-console
          console.warn('[tsServerBridge] stdin write returned false (backpressure), pending=', this.pending.size);
        }
      } catch (err: any) {
        clearTimeout(timeout);
        this.pending.delete(seq);
        reject(new Error(`tsserver stdin write threw: ${err?.message ?? err}`));
      }
    });
  }
}

