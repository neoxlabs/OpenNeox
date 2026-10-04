/**
 * @openneox/sdk/tools · 内置工具套件
 *
 * 此前 fs() / shell() 返回空数组, web() / mcp() / agent() 是 stub ——
 * 结果是 SDK 一个工具都不自带, 用户想让 agent 碰文件得自己实现一遍。这一版把
 * fs() 与 shell() 做成真实现(设计文档 §3.1 / §3.2), 其余仍标为未实现并显式抛错,
 * 不再返回空数组假装可用。
 *
 * 安全约束(这两个工具直接碰用户机器, 边界必须硬):
 *   · fs 的所有路径都 resolve 后校验必须落在 root 内, 越界即拒(含符号链接逃逸)
 *   · fs 默认只读; 写操作要显式 allowWrite, 且写工具标 dangerous
 *   · shell 默认拒绝一切命令; 必须显式给 allowedCommands 白名单
 *   · shell 工具一律标 dangerous —— permission:'auto' 下也会被拦, 要跑得自己给 handler
 *
 * 这一层是 Node-only(用了 node:fs / node:child_process), 只从 '@openneox/sdk/tools'
 * 子路径导出, 主入口保持浏览器可用。
 */

import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { tool, type AnyNeoxSdkTool, type NeoxSdkTool } from '../tool.js';

const execFileAsync = promisify(execFile);

export interface FsToolsOptions {
  /** 允许访问的根目录, 默认 process.cwd() */
  root?: string;
  /** 是否放开写入/编辑工具, 默认 false(只读) */
  allowWrite?: boolean;
  /** 排除的路径片段, 命中即拒。默认排除常见的敏感与体积目录 */
  exclude?: string[];
  /** 单文件读取上限(字节), 默认 256KB —— 超了直接拒, 不要把上下文撑爆 */
  maxBytes?: number;
}

export interface ShellToolsOptions {
  /** 允许执行的命令白名单。不给或给空数组 = 不放行任何命令 */
  allowedCommands?: string[];
  /** 工作目录, 默认 process.cwd() */
  cwd?: string;
  env?: Record<string, string>;
  /** 单条命令超时(ms), 默认 30s */
  timeout?: number;
  /** 输出截断上限(字符), 默认 20000 */
  maxOutputChars?: number;
}

export interface WebToolsOptions {
  userAgent?: string;
  timeout?: number;
}

const DEFAULT_EXCLUDE = ['.git/', 'node_modules/', '.env', '.ssh/', 'id_rsa', '.aws/', '.npmrc'];

/**
 * fs 系列: read_file / list_files / search_files (+ allowWrite 时 write_file / edit_file)
 *
 * @example
 *   const agent = new Agent({
 *     model: 'claude-sonnet-4-6',
 *     tools: builtinTools.fs({ root: './src' }),
 *     permission: 'auto',
 *   });
 */
export function fs(options: FsToolsOptions = {}): AnyNeoxSdkTool[] {
  const root = resolve(options.root ?? process.cwd());
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;
  const maxBytes = options.maxBytes ?? 256 * 1024;

  /* root 自己可能就是符号链接 (macOS 的 /tmp → /private/tmp 就是),
   * 所以 realpath 校验必须拿 realRoot 比, 不能拿原始 root 比 ——
   * 否则合法路径会被误判成逃逸。解析一次缓存住。 */
  let realRootPromise: Promise<string> | null = null;
  const realRoot = () => (realRootPromise ??= fsp.realpath(root).catch(() => root));

  const escapes = (rel: string) => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);

  /* 排除按路径段匹配, 不管在第几层: `nested/.env`、`a/b/.ssh/config` 一样拦。
   * 'x/' 形式是目录名 (段完全相等), 其余是文件名前缀 (`.env` 也拦 `.env.local`)。
   * read / list / search / write 全走这一个判断 —— 按根相对前缀匹配会漏掉嵌套的。 */
  const isExcluded = (rel: string): boolean => {
    const segments = rel.split(sep).filter(Boolean);
    return exclude.some((p) => {
      const dir = p.endsWith('/');
      const name = dir ? p.slice(0, -1) : p;
      if (name.includes('/')) return segments.join('/').startsWith(name);
      return segments.some((s) => (dir ? s === name : s.startsWith(name)));
    });
  };

  /**
   * 目标 (可能还不存在) 的真实路径: 取最近一个存在的祖先做 realpath, 再拼上还不存在的那几段。
   * 目标不存在时如果只是跳过检查, 父目录是指向 root 外的链接就能写出去 —— 这里正是为了堵它。
   * ENOENT / ENOTDIR 以外的错误 (权限、链接环…) 一律当不安全。
   */
  const realTarget = async (target: string): Promise<string | null> => {
    const missing: string[] = [];
    let cur = target;
    for (;;) {
      try {
        return join(await fsp.realpath(cur), ...missing.reverse());
      } catch (err: any) {
        if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return null;
        const parent = resolve(cur, '..');
        if (parent === cur) return null;
        missing.push(relative(parent, cur));
        cur = parent;
      }
    }
  };

  /** 把用户/模型给的相对路径钉死在 root 内 —— 这是这组工具唯一的安全边界 */
  const safePath = async (input: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    if (isAbsolute(input)) return { ok: false, error: 'absolute paths are not allowed; use a path relative to the root' };
    const target = resolve(root, input);
    const rel = relative(root, target);
    if (escapes(rel)) return { ok: false, error: 'path escapes the allowed root' };
    if (isExcluded(rel)) return { ok: false, error: `path is excluded by policy: ${rel.split(sep).join('/')}` };
    /* 符号链接逃逸: 两边都取真实路径再比, 链接指到 root 里的排除目录也拦 */
    const [real, base] = await Promise.all([realTarget(target), realRoot()]);
    if (real === null) return { ok: false, error: 'path could not be resolved safely' };
    const realRel = relative(base, real);
    if (escapes(realRel)) return { ok: false, error: 'symlink escapes the allowed root' };
    if (isExcluded(realRel)) return { ok: false, error: `path is excluded by policy: ${realRel.split(sep).join('/')}` };
    return { ok: true, path: target };
  };

  /**
   * 遍历 (list / search) 里的每一项都过同一道 safePath。符号链接的目录不往里走 ——
   * 在 root 内的链接目录内容本来就能从原位置遍历到, 往里走只会多出重复和链接环。
   */
  const walkEntries = async (
    dir: string,
    depth: number,
    maxDepth: number,
    visit: (entry: { rel: string; abs: string; isDir: boolean }) => Promise<boolean>,
  ): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs);
      const checked = await safePath(rel);
      if (!checked.ok) continue;
      const isDir = e.isDirectory();
      if (!(await visit({ rel: rel.split(sep).join('/'), abs, isDir }))) return;
      if (isDir && depth < maxDepth) await walkEntries(abs, depth + 1, maxDepth, visit);
    }
  };

  const readFile = tool({
    name: 'read_file',
    description:
      'Read a UTF-8 text file inside the workspace root. Path must be relative to the root. Returns the file content.',
    schema: z.object({ path: z.string() }),
    readOnly: true,
    handler: async ({ path }) => {
      const p = await safePath(path);
      if (!p.ok) return { error: p.error };
      const stat = await fsp.stat(p.path).catch(() => null);
      if (!stat) return { error: `no such file: ${path}` };
      if (stat.isDirectory()) return { error: `${path} is a directory; use list_files` };
      if (stat.size > maxBytes) return { error: `file too large (${stat.size} bytes, limit ${maxBytes})` };
      return { path, content: await fsp.readFile(p.path, 'utf8') };
    },
  });

  const listFiles = tool({
    name: 'list_files',
    description:
      'List files and directories inside the workspace root. Path is relative to the root; omit it to list the root itself.',
    schema: z.object({ path: z.string().optional(), recursive: z.boolean().optional() }),
    readOnly: true,
    handler: async ({ path = '.', recursive = false }) => {
      const p = await safePath(path);
      if (!p.ok) return { error: p.error };
      const out: string[] = [];
      await walkEntries(p.path, 0, recursive ? 6 : -1, async ({ rel, isDir }) => {
        out.push(isDir ? `${rel}/` : rel);
        return out.length < 2000;
      });
      return { path, entries: out };
    },
  });

  const searchFiles = tool({
    name: 'search_files',
    description:
      'Search for a literal string across text files under the workspace root. Returns matching file paths with line numbers.',
    schema: z.object({ query: z.string(), path: z.string().optional(), maxResults: z.number().optional() }),
    readOnly: true,
    handler: async ({ query, path = '.', maxResults = 50 }) => {
      const p = await safePath(path);
      if (!p.ok) return { error: p.error };
      const hits: Array<{ path: string; line: number; text: string }> = [];
      await walkEntries(p.path, 0, 6, async ({ rel, abs, isDir }) => {
        if (isDir) return true;
        const stat = await fsp.stat(abs).catch(() => null);
        if (!stat?.isFile() || stat.size > maxBytes) return true;
        const content = await fsp.readFile(abs, 'utf8').catch(() => null);
        if (content === null) return true;
        content.split('\n').forEach((text, i) => {
          if (hits.length < maxResults && text.includes(query)) {
            hits.push({ path: rel, line: i + 1, text: text.slice(0, 300) });
          }
        });
        return hits.length < maxResults;
      });
      return { query, hits };
    },
  });

  const tools: AnyNeoxSdkTool[] = [readFile, listFiles, searchFiles];
  if (!options.allowWrite) return tools;

  const writeFile = tool({
    name: 'write_file',
    description:
      'Create or overwrite a UTF-8 text file inside the workspace root. Overwrites without asking — prefer edit_file for existing files.',
    schema: z.object({ path: z.string(), content: z.string() }),
    dangerous: true,
    handler: async ({ path, content }) => {
      const p = await safePath(path);
      if (!p.ok) return { error: p.error };
      await fsp.mkdir(resolve(p.path, '..'), { recursive: true });
      /* 建完父目录再验一次: 检查和写入之间目录被换成链接的窗口缩到最小 */
      const again = await safePath(path);
      if (!again.ok) return { error: again.error };
      await fsp.writeFile(p.path, content, 'utf8');
      return { path, bytes: Buffer.byteLength(content, 'utf8') };
    },
  });

  const editFile = tool({
    name: 'edit_file',
    description:
      'Replace an exact substring in a file inside the workspace root. Fails when the string is missing or appears more than once.',
    schema: z.object({ path: z.string(), find: z.string(), replace: z.string() }),
    dangerous: true,
    handler: async ({ path, find, replace }) => {
      const p = await safePath(path);
      if (!p.ok) return { error: p.error };
      const content = await fsp.readFile(p.path, 'utf8').catch(() => null);
      if (content === null) return { error: `no such file: ${path}` };
      const occurrences = content.split(find).length - 1;
      if (occurrences === 0) return { error: 'find string not present in file' };
      if (occurrences > 1) return { error: `find string appears ${occurrences} times; make it unique` };
      await fsp.writeFile(p.path, content.replace(find, replace), 'utf8');
      return { path, replaced: 1 };
    },
  });

  return [...tools, writeFile, editFile];
}

/**
 * shell 系列: run_command (白名单内的命令)
 *
 * 默认不放行任何命令。命令以 execFile 执行, **不经过 shell**, 所以不存在
 * `rm -rf / && ...` 这类拼接注入 —— 参数是数组, 不是字符串。
 */
export function shell(options: ShellToolsOptions = {}): AnyNeoxSdkTool[] {
  const allowed = new Set(options.allowedCommands ?? []);
  const cwd = options.cwd ?? process.cwd();
  const timeout = options.timeout ?? 30_000;
  const maxOutputChars = options.maxOutputChars ?? 20_000;

  const runCommand = tool({
    name: 'run_command',
    description:
      allowed.size > 0
        ? `Run one of the allowed commands: ${[...allowed].join(', ')}. Arguments are passed as an array; no shell interpolation.`
        : 'Command execution is disabled: no commands are allow-listed.',
    schema: z.object({ command: z.string(), args: z.array(z.string()).optional() }),
    dangerous: true,
    timeout: timeout + 5_000,
    handler: async ({ command, args = [] }) => {
      if (allowed.size === 0) return { error: 'no commands are allow-listed for this agent' };
      if (!allowed.has(command)) {
        return { error: `command "${command}" is not allow-listed (allowed: ${[...allowed].join(', ')})` };
      }
      try {
        const { stdout, stderr } = await execFileAsync(command, args, {
          cwd,
          timeout,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          maxBuffer: 4 * 1024 * 1024,
        });
        return {
          exitCode: 0,
          stdout: stdout.slice(0, maxOutputChars),
          stderr: stderr.slice(0, maxOutputChars),
        };
      } catch (err: any) {
        return {
          exitCode: typeof err?.code === 'number' ? err.code : 1,
          stdout: String(err?.stdout ?? '').slice(0, maxOutputChars),
          stderr: String(err?.stderr ?? err?.message ?? '').slice(0, maxOutputChars),
        };
      }
    },
  });

  return [runCommand];
}

/** web 系列: WebFetch / WebSearch —— 未实现 */
export function web(_options?: WebToolsOptions): AnyNeoxSdkTool[] {
  throw new Error(
    '[neox-sdk] builtinTools.web() is not implemented yet. Implement fetching as your own tool for now.',
  );
}

/** MCP: 加载 MCP servers 并注册为 tools —— 未实现 */
export function mcp(_configOrPath: string | Record<string, unknown>): AnyNeoxSdkTool[] {
  throw new Error(
    '[neox-sdk] builtinTools.mcp() is not implemented yet. MCP mounting lives in the Neox product runtime.',
  );
}

/** Sub-agent: 把一个任务 Agent 作为 tool 暴露给 parent(对标 Claude handoffs) */
export interface TaskAgentToolOptions {
  name: string;
  description: string;
  model: string;
  systemPrompt?: string;
  tools?: AnyNeoxSdkTool[];
}

/**
 * 把一个子 Agent 包装成工具。父 agent 调用它时, 子 agent 独立跑一轮并把 text 交回。
 * 子 agent 的工具集与模型可以和父的不同 —— 这是控制上下文体积最有效的手段。
 */
export function agent(options: TaskAgentToolOptions): AnyNeoxSdkTool {
  return tool({
    name: options.name,
    description: options.description,
    schema: z.object({ task: z.string() }),
    readOnly: false,
    timeout: 300_000,
    handler: async ({ task }) => {
      /* 动态 import 避免 tools 子路径与主入口形成循环依赖 */
      const { Agent } = await import('../agent.js');
      const sub = new Agent({
        model: options.model,
        systemPrompt: options.systemPrompt,
        tools: options.tools ?? [],
        permission: 'auto',
      });
      const res = await sub.run(task);
      return { text: res.text, stopReason: res.stopReason, usage: res.usage };
    },
  });
}

/** Namespace re-export 形式,便于 `builtinTools.fs()`, `builtinTools.shell()` 调用 */
export const builtinTools = { fs, shell, web, mcp, agent };
