
export type ParsedEvent = {
  /** 给 timeline 的一行人话; 空串表示这条事件不值得展示 */
  line: string;
  /** 模型最终要看的正文 (助手回复), 会拼进结果 */
  text?: string;
  replacesText?: boolean;
  /** 观察到的工具调用名, 用于结尾摘要 */
  toolName?: string;
  /** 这条事件表示任务结束 */
  done?: boolean;
  /** 结束时的错误信息 */
  error?: string;
  /** 这个错误重试也没用 (额度 / 鉴权 / 未登录) —— runner 立刻停, 不陪它把几轮重连跑完 */
  fatal?: boolean;
};

export function isFatalAgentError(message: string): boolean {
  return /\b(401|402|403)\b|unauthori[sz]ed|forbidden|insufficient[_ ]?(quota|balance|credit)|quota|billing|额度|余额|欠费|not (logged|signed) in|please (log|sign) ?in|invalid[_ ]api[_ ]key|authentication/i.test(message);
}

export type StreamParser = {
  /** 喂一行, 返回 0..n 个事件 */
  feed(line: string): ParsedEvent[];
};

function safeJson(line: string): any | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const b = block as Record<string, any>;
          if (typeof b.text === 'string') return b.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  return '';
}

/**
 * Claude Code `--output-format stream-json`
 *
 *   每行一个事件, `type` 取 system / assistant / user / result。
 *   assistant 的 message.content 是 Anthropic 的 block 数组 (text / tool_use)。
 */
function createClaudeStreamJsonParser(): StreamParser {
  return {
    feed(line) {
      const ev = safeJson(line);
      if (!ev || typeof ev !== 'object') {
        const t = line.trim();
        return t ? [{ line: t }] : [];
      }

      switch (ev.type) {
        case 'system':
          /* init 事件里有 session_id / cwd / 可用工具, 对用户没信息量 */
          return [];

        case 'assistant': {
          const out: ParsedEvent[] = [];
          const blocks = ev.message?.content;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                out.push({ line: b.text.trim(), text: b.text });
              } else if (b?.type === 'tool_use' && typeof b.name === 'string') {
                out.push({ line: `· ${b.name}`, toolName: b.name });
              }
            }
          }
          return out;
        }

        case 'user':
          /* tool_result 回灌, 内容通常很长且是给模型看的 */
          return [];

        case 'result': {
          const isError = ev.is_error === true || ev.subtype === 'error_max_turns';
          const text = typeof ev.result === 'string' ? ev.result : '';
          return [{
            line: isError ? `✗ ${ev.subtype ?? 'error'}` : '✓ 完成',
            text,
            /* result 复述的就是最后那条 assistant 消息, 追加会说两遍 */
            replacesText: Boolean(text),
            done: true,
            error: isError ? (text || String(ev.subtype ?? 'error')) : undefined,
          }];
        }

        default:
          /* 解析成功但类型不认识 = 我们不关心的协议事件 (rate_limit_event 之类)。
           * 原样打出来只是给用户看一串 JSON —— 兜底展示只留给**没解析成功**的行。 */
          return [];
      }
    },
  };
}

/**
 * Codex `exec --json`
 *
 *   事件形状比 Claude 那边松, 而且换版本会变。所以这里按「能认出多少认多少」
 *   写: 先试几个已知字段位置, 都不中就把整行当文本。
 */
function createCodexJsonParser(): StreamParser {
  return {
    feed(line) {
      const ev = safeJson(line);
      if (!ev || typeof ev !== 'object') {
        const t = line.trim();
        return t ? [{ line: t }] : [];
      }

      /* 常见形态一: { type: 'item.completed', item: { type, text, ... } }
       * 常见形态二: { msg: { type: 'agent_message', message } }  (protocol 事件)
       * 两种都试, 顺序无所谓 —— 命中一个就够。 */
      const item = ev.item ?? ev.msg ?? ev;
      const kind = String(item?.type ?? ev.type ?? '');

      if (/agent_message|assistant|message/.test(kind)) {
        const text = textOf(item.message ?? item.text ?? item.content);
        return text.trim() ? [{ line: text.trim(), text }] : [];
      }
      if (/reasoning|thinking/.test(kind)) {
        return [];
      }
      if (/command|exec|shell/.test(kind)) {
        const cmd = typeof item.command === 'string'
          ? item.command
          : Array.isArray(item.command) ? item.command.join(' ') : '';
        return [{ line: cmd ? `· $ ${cmd.slice(0, 160)}` : '· shell', toolName: 'shell' }];
      }
      if (/patch|apply/.test(kind)) {
        return [{ line: '· apply_patch', toolName: 'apply_patch' }];
      }
      if (/rate_limit|token_count|usage|heartbeat/.test(kind)) {
        return [];
      }
      if (/error|failed/.test(kind)) {
        const errObj = item.error && typeof item.error === 'object' ? (item.error as { message?: unknown }).message : undefined;
        const message = textOf(item.message ?? errObj ?? item.error) || kind;
        return [{ line: `✗ ${message}`, error: message, fatal: isFatalAgentError(message), done: /turn|task|session/.test(kind) }];
      }
      if (/turn\.completed|task_complete|session\.completed|thread\.completed/.test(kind)) {
        return [{ line: '✓ 完成', done: true }];
      }

      /* 同上: 认得出是 JSON 但不认识类型的, 不往界面上倒 */
      return [];
    },
  };
}


/** 错误事件统一收口: 给人看的一行 + 给模型的原因 + 要不要立刻停 */
function errorEvent(message: string, done = true): ParsedEvent {
  return { line: `✗ ${message}`, error: message, fatal: isFatalAgentError(message), done };
}

/**
 * Factory Droid `droid exec -o stream-json`
 *
 *   system(init) / message(role user|assistant, text) / tool_call(toolName) / tool_result / completion(finalText)。
 *   completion.finalText 就是最后一条 assistant 消息 —— 跟 Claude 的 result 一样要替换不能追加。
 */
function createDroidStreamJsonParser(): StreamParser {
  let sawSpecificError = false;
  return {
    feed(line) {
      const ev = safeJson(line);
      if (!ev || typeof ev !== 'object') {
        const t = line.trim();
        return t ? [{ line: t }] : [];
      }
      switch (ev.type) {
        case 'message':
          if (ev.role === 'assistant' && typeof ev.text === 'string' && ev.text.trim()) {
            return [{ line: ev.text.trim(), text: `${ev.text}\n` }];
          }
          return [];
        case 'tool_call': {
          const name = String(ev.toolName ?? ev.toolId ?? 'tool');
          return [{ line: `· ${name}`, toolName: name }];
        }
        case 'completion': {
          const text = typeof ev.finalText === 'string' ? ev.finalText : '';
          return [{ line: '✓ 完成', text, replacesText: Boolean(text), done: true }];
        }
        case 'error': {
          const message = textOf(ev.message ?? ev.error) || 'error';
          /* droid 先报真原因 (如 "405 Method Not Allowed"), 再补一句泛泛的 "Exec failed" ——
           * 后者只标记结束, 不能盖掉前者 */
          if (message === 'Exec failed' && sawSpecificError) return [{ line: '', done: true }];
          sawSpecificError = true;
          /* 没登录 Factory 又没配自定义模型 —— 光一句 "Authentication failed" 用户不知道下一步 */
          if (/Authentication failed/i.test(message)) {
            return [errorEvent(`${message} —— 在终端运行一次 \`droid\` 按提示登录；或在 ~/.factory/settings.json 的 customModels 里配自己的模型，Neox 会自动用它，不需要登录。`)];
          }
          return [errorEvent(message)];
        }
        default:
          return [];
      }
    },
  };
}

/**
 * OpenCode `opencode run --format json`
 *
 *   step_start / text(part.text) / tool_use(part.tool) / step_finish(part.reason) / error(error.data.message)。
 *   step_finish 每一步都会发, 只有 reason=stop 才是整轮结束 (tool-calls 表示还要接着跑)。
 */
function createOpencodeJsonParser(): StreamParser {
  return {
    feed(line) {
      const ev = safeJson(line);
      if (!ev || typeof ev !== 'object') {
        const t = line.trim();
        return t ? [{ line: t }] : [];
      }
      const part = ev.part ?? {};
      switch (ev.type) {
        case 'text':
          return typeof part.text === 'string' && part.text.trim()
            ? [{ line: part.text.trim(), text: `${part.text}\n` }]
            : [];
        case 'tool_use': {
          const name = String(part.tool ?? 'tool');
          const title = typeof part.state?.title === 'string' ? part.state.title : '';
          return [{ line: `· ${name}${title ? ` ${title.slice(0, 120)}` : ''}`, toolName: name }];
        }
        case 'step_finish':
          return part.reason === 'stop' ? [{ line: '✓ 完成', done: true }] : [];
        case 'error': {
          const err = ev.error ?? {};
          return [errorEvent(textOf(err.data?.message ?? err.message) || String(err.name ?? 'error'))];
        }
        default:
          return [];
      }
    },
  };
}

/**
 * Kimi Code `kimi -p … --output-format stream-json`
 *
 *   OpenAI 消息形状: {role:'assistant', content?, tool_calls?} / {role:'tool'} / {role:'meta'}。
 *   **没有结束事件** —— 以进程退出码为准; 失败时它往 stdout 打一行非 JSON 的 `error: …`。
 */
function createKimiStreamJsonParser(): StreamParser {
  let producedAnything = false;
  return {
    feed(line) {
      const ev = safeJson(line);
      if (!ev || typeof ev !== 'object') {
        const t = line.trim();
        if (/^error:/i.test(t)) return [errorEvent(t.replace(/^error:\s*/i, ''))];
        return t ? [{ line: t }] : [];
      }
      if (ev.role === 'meta' && ev.type === 'turn.step.retrying' && !producedAnything
        && /connection/i.test(String(ev.error_name ?? '')) && Number(ev.failed_attempt) >= 2) {
        return [{ ...errorEvent(`连不上它配置的模型接口（${ev.error_message ?? ev.error_name}）—— 检查 ~/.kimi-code/config.toml 里的 base_url 和 api_key`), fatal: true }];
      }
      if (ev.role !== 'assistant') return [];
      producedAnything = true;
      const out: ParsedEvent[] = [];
      const content = textOf(ev.content);
      if (content.trim()) out.push({ line: content.trim(), text: `${content}\n` });
      if (Array.isArray(ev.tool_calls)) {
        for (const call of ev.tool_calls) {
          const name = String(call?.function?.name ?? 'tool');
          out.push({ line: `· ${name}`, toolName: name });
        }
      }
      return out;
    },
  };
}

function createClineJsonParser(): StreamParser {
  return {
    feed(line) {
      const ev = safeJson(line);
      if (!ev || typeof ev !== 'object') {
        const t = line.trim();
        return t ? [{ line: t }] : [];
      }
      if (ev.type !== 'agent_event' || !ev.event) return [];
      const e = ev.event;
      if (e.type === 'content_end' && e.contentType === 'text' && typeof e.text === 'string' && e.text.trim()) {
        return [{ line: e.text.trim(), text: `${e.text}\n` }];
      }
      if (e.type === 'content_start' && e.contentType === 'tool') {
        const name = String(e.toolName ?? 'tool');
        return [{ line: `· ${name}`, toolName: name }];
      }
      if (e.type === 'done') {
        const text = typeof e.text === 'string' ? e.text : '';
        if (e.reason === 'error') return [errorEvent(text || 'error')];
        return [{ line: '✓ 完成', text, replacesText: Boolean(text), done: true }];
      }
      return [];
    },
  };
}

function createTextParser(): StreamParser {
  return {
    feed(line) {
      const t = line.replace(/\s+$/, '');
      return t.trim() ? [{ line: t, text: `${t}\n` }] : [];
    },
  };
}

export function createStreamParser(format: string): StreamParser {
  switch (format) {
    case 'claude-stream-json': return createClaudeStreamJsonParser();
    case 'codex-json': return createCodexJsonParser();
    case 'droid-stream-json': return createDroidStreamJsonParser();
    case 'opencode-json': return createOpencodeJsonParser();
    case 'kimi-stream-json': return createKimiStreamJsonParser();
    case 'cline-json': return createClineJsonParser();
    default: return createTextParser();
  }
}
