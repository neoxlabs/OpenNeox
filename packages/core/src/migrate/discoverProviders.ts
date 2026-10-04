
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

import type { ProviderProtocol } from '@neoxlabs/kernel/types/configTypes.js';
import { parseTomlSections } from './tomlSections.js';

export interface ExternalProviderCandidate {
  /** 归一化后的 Neox provider id */
  id: string;
  /** 用户可读名 (源里的 name, 没有就用 id) */
  name: string;
  /** 'Claude Code' | 'Codex' | 'CC Switch' | 'Environment' */
  source: string;
  /** 从哪个文件/哪个变量读出来的 —— 让用户能自己去核对 */
  sourcePath: string;
  protocol: ProviderProtocol;
  baseUrl?: string;
  urlSuffix?: string;
  defaultModel?: string;
  /** Key 是否读到了。false = 端点信息可用但要用户补 Key */
  hasKey: boolean;
  /** Key 是从哪拿的: 配置文件里的字面量 / 进程环境 / shell 启动文件 */
  keyOrigin: 'config' | 'dotenv' | 'process-env' | 'shell-profile' | null;
  /** 源里声明的环境变量名 (Codex 的 env_key) —— 没读到值时告诉用户"去哪找" */
  keyEnvName?: string;
  /** 掩码, 只够用户认出"是哪一把", 认不出内容 */
  keyPreview: string | null;
  /** ~/.neox 里已经有同 id 或同 (baseUrl+protocol) 的了 */
  alreadyImported: boolean;
  /**
   * 明文 Key —— **只在 includeSecrets 时存在**。
   * 调用方拿到后必须直接交给 ProviderStore.addProvider (它落盘前会 wrap 成 enc:v1:),
   * 不许日志、不许回传 renderer。
   */
  apiKey?: string;
}

/** 协议 → 端点后缀。跟引导页 BRAND 表里那份保持一致 (那份是 UI 的, 这份是协议层的)。 */
const SUFFIX_BY_PROTOCOL: Partial<Record<ProviderProtocol, string>> = {
  'openai': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic': '/v1/messages',
  'gemini': '/v1beta/models',
  'deepseek': '/chat/completions',
  'openrouter': '/chat/completions',
  'grok': '/chat/completions',
  'mistral': '/chat/completions',
  'groq': '/chat/completions',
  'together': '/chat/completions',
  'kimi': '/chat/completions',
  'glm': '/chat/completions',
  'qwen': '/chat/completions',
  'minimax': '/chat/completions',
};

/**
 * 认得出的环境变量 —— 变量名 → (协议, 官方 base_url, 显示名)。
 *
 *   只认白名单。不要写成"名字里带 API_KEY 就算一个供应商" —— 那会把用户
 *   一堆跟大模型无关的 Key (Stripe / GitHub / 高德) 全端到这一屏上来。
 */
const ENV_PROVIDERS: Array<{
  envNames: string[];
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  /** 允许被同源的 *_BASE_URL 覆盖 (三方代理很常见) */
  baseUrlEnv?: string[];
}> = [
  { envNames: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], id: 'anthropic', name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', baseUrlEnv: ['ANTHROPIC_BASE_URL'] },
  { envNames: ['OPENAI_API_KEY'], id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', baseUrlEnv: ['OPENAI_BASE_URL', 'OPENAI_API_BASE'] },
  { envNames: ['DEEPSEEK_API_KEY'], id: 'deepseek', name: 'DeepSeek', protocol: 'deepseek', baseUrl: 'https://api.deepseek.com' },
  { envNames: ['OPENROUTER_API_KEY'], id: 'openrouter', name: 'OpenRouter', protocol: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { envNames: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], id: 'gemini', name: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
  { envNames: ['XAI_API_KEY', 'GROK_API_KEY'], id: 'grok', name: 'xAI Grok', protocol: 'grok', baseUrl: 'https://api.x.ai/v1' },
  { envNames: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'], id: 'kimi', name: 'Moonshot Kimi', protocol: 'kimi', baseUrl: 'https://api.moonshot.cn/v1' },
  { envNames: ['ZHIPUAI_API_KEY', 'GLM_API_KEY'], id: 'glm', name: '智谱 GLM', protocol: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { envNames: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'], id: 'qwen', name: '通义千问', protocol: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { envNames: ['MINIMAX_API_KEY'], id: 'minimax', name: 'MiniMax', protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1' },
  { envNames: ['MISTRAL_API_KEY'], id: 'mistral', name: 'Mistral', protocol: 'mistral', baseUrl: 'https://api.mistral.ai/v1' },
  { envNames: ['GROQ_API_KEY'], id: 'groq', name: 'Groq', protocol: 'groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { envNames: ['TOGETHER_API_KEY'], id: 'together', name: 'Together', protocol: 'together', baseUrl: 'https://api.together.xyz/v1' },
];

/** 一把 Key 值得导吗 —— 太短的一般是占位符 (`your-key-here` / `xxx`) */
function looksLikeKey(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 12) return false;
  if (/^(your|test|dummy|placeholder|xxx+|<.*>)/i.test(s)) return false;
  return true;
}

/** 掩码 —— 前 4 后 4, 中间恒定 3 个点, 不泄漏长度以外的信息 */
export function maskKey(k: string): string {
  const s = String(k);
  if (s.length <= 10) return '•'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function readJson(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 静态解析 shell 启动文件里的 `export NAME=value`。
 *
 *   为什么必须读这个: 桌面 App 从 Finder / Dock 拉起来时**没有 login shell**,
 *   `process.env` 里根本没有用户在 .zshrc 里 export 的那些 Key。CLI 跑起来有,
 *   桌面没有 —— 同一个用户同一台机器, 两个入口扫出来的结果会不一样。
 *
 *   只认字面量。带 `$(cmd)` / 反引号 / `${VAR}` 的一律丢掉 —— 要拿到那种值就得
 *   跑用户的 shell, 而"为了填个 Key 去执行用户的启动脚本"这笔交易不划算。
 */
function parseShellProfiles(home: string): Map<string, { value: string; file: string }> {
  const out = new Map<string, { value: string; file: string }>();
  const files = ['.zshenv', '.zprofile', '.zshrc', '.bash_profile', '.bashrc', '.profile'];
  for (const f of files) {
    const file = path.join(home, f);
    let text: string;
    try {
      if (!fs.existsSync(file)) continue;
      text = fs.readFileSync(file, 'utf-8');
    } catch { continue; }
    /* 逐行, 不用 /m 一把梭 —— 行内注释和续行都靠逐行才好判 */
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(?:export\s+)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!m) continue;
      const name = m[1];
      let value = m[2].trim();
      /* 去掉行尾注释 (只对没引号的裸值; 引号里的 # 是内容) */
      if (!/^["']/.test(value)) value = value.split(/\s+#/)[0].trim();
      /* 脱引号 */
      const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
      if (quoted) value = quoted[2];
      if (!value) continue;
      /* 不是字面量就放弃 —— 见函数头 */
      if (/[`]|\$\(|\$\{|\$[A-Za-z_]/.test(value)) continue;
      /* 先扫到的赢: zshenv → zprofile → zshrc, 跟 shell 的加载顺序一致 */
      if (!out.has(name)) out.set(name, { value, file });
    }
  }
  return out;
}

function parseDotEnvFiles(home: string): Map<string, { value: string; file: string }> {
  const out = new Map<string, { value: string; file: string }>();

  const files: string[] = [
    path.join(home, '.codex', '.env'),
    path.join(home, '.claude', '.env'),
  ];
  /* 启动器的 per-profile .env —— 只下探一层, 不递归 */
  for (const base of [
    path.join(home, '.codex-config-ui', 'codex-oauth-profiles'),
    path.join(home, '.codex-config-ui', 'claudecode-oauth-profiles'),
  ]) {
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) files.push(path.join(base, entry.name, '.env'));
      }
    } catch { /* 没有这个启动器就跳过 */ }
  }

  for (const file of files) {
    let text: string;
    try {
      if (!fs.existsSync(file)) continue;
      text = fs.readFileSync(file, 'utf-8');
    } catch { continue; }
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      /* dotenv 允许带 export 前缀, 也允许不带 */
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let value = m[2].trim();
      const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
      if (quoted) value = quoted[2];
      if (!value) continue;
      /* 跟 shell profile 同一条规矩: 不是字面量就不要 (不代跑用户的东西) */
      if (/[`]|\$\(|\$\{|\$[A-Za-z_]/.test(value)) continue;
      if (!out.has(m[1])) out.set(m[1], { value, file });
    }
  }
  return out;
}

interface EnvLookup {
  get(name: string): { value: string; origin: 'process-env' | 'dotenv' | 'shell-profile'; from: string } | null;
}

function buildEnvLookup(home: string, env: NodeJS.ProcessEnv): EnvLookup {
  const dotenv = parseDotEnvFiles(home);
  const profile = parseShellProfiles(home);
  return {
    get(name: string) {
      /* 顺序 = 由近及远: 进程自己的环境 → 工具自带的 .env → 用户 shell 启动文件。
       * dotenv 排在 shell 前面: 它是**这个工具**的配置, 比全局 export 更贴题。 */
      const live = env[name];
      if (looksLikeKey(live)) return { value: String(live).trim(), origin: 'process-env', from: `环境变量 ${name}` };
      const d = dotenv.get(name);
      if (d && looksLikeKey(d.value)) return { value: d.value, origin: 'dotenv', from: d.file };
      const p = profile.get(name);
      if (p && looksLikeKey(p.value)) return { value: p.value, origin: 'shell-profile', from: p.file };
      return null;
    },
  };
}

/** Codex 的 wire_api → Neox 协议。认不出的当 openai 兼容 (三方代理绝大多数是). */
function protocolFromWireApi(wireApi: unknown, baseUrl: string): ProviderProtocol {
  if (wireApi === 'responses') return 'openai-responses';
  if (/anthropic\.com|\/v1\/messages/.test(baseUrl)) return 'anthropic';
  return 'openai';
}

function normalizeId(name: string): string {
  const s = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'provider';
}

/* ── 各源 ─────────────────────────────────────────────────────────────── */

/**
 * Claude Code —— `~/.claude/settings.json` 和 `settings.local.json` 的 `env` 段。
 *
 *   官方推荐的自定义端点写法就是往这里塞 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN,
 *   国内用三方 Claude 代理的用户几乎人手一份。
 *   `apiKeyHelper` (一条命令) 不碰 —— 见文件头第 3 条。
 */
function fromClaudeSettings(home: string, out: ExternalProviderCandidate[]): void {
  for (const f of ['settings.json', 'settings.local.json']) {
    const file = path.join(home, '.claude', f);
    const json = readJson(file);
    const env = json?.env;
    if (!env || typeof env !== 'object') continue;

    const key = looksLikeKey(env.ANTHROPIC_AUTH_TOKEN) ? env.ANTHROPIC_AUTH_TOKEN
      : looksLikeKey(env.ANTHROPIC_API_KEY) ? env.ANTHROPIC_API_KEY
        : null;
    const baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL.trim()
      ? env.ANTHROPIC_BASE_URL.trim()
      : 'https://api.anthropic.com';
    /* 没 Key 又是官方端点 = 这份配置里根本没配 BYOK (走的订阅登录), 没什么可导的 */
    if (!key && baseUrl === 'https://api.anthropic.com') continue;

    out.push({
      id: normalizeId(baseUrl === 'https://api.anthropic.com' ? 'anthropic' : `claude-${new URL(baseUrl).hostname.split('.')[0]}`),
      name: baseUrl === 'https://api.anthropic.com' ? 'Anthropic' : `Anthropic (${new URL(baseUrl).hostname})`,
      source: 'Claude Code',
      sourcePath: file,
      protocol: 'anthropic',
      baseUrl,
      urlSuffix: SUFFIX_BY_PROTOCOL.anthropic,
      defaultModel: typeof env.ANTHROPIC_MODEL === 'string' ? env.ANTHROPIC_MODEL : undefined,
      hasKey: !!key,
      keyOrigin: key ? 'config' : null,
      keyPreview: key ? maskKey(key) : null,
      alreadyImported: false,
      apiKey: key ? String(key) : undefined,
    });
  }
}

/**
 * Codex —— `[model_providers.<id>]` (name / base_url / env_key / wire_api),
 * 外加 `~/.codex/auth.json` 里 apikey 模式下的 OPENAI_API_KEY。
 *
 *   Key 通常**不在** toml 里 (只有 env_key 这个变量名), 所以要拿 EnvLookup 去兑;
 *   兑不到就是 hasKey=false 的那一档 —— 照样列。
 */
function fromCodex(home: string, envLookup: EnvLookup, out: ExternalProviderCandidate[]): void {
  const file = path.join(home, '.codex', 'config.toml');
  let text: string | null = null;
  try { if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf-8'); } catch { /* 读不了跳过 */ }

  if (text) {
    for (const [section, kv] of parseTomlSections(text)) {
      const m = /^model_providers\.([^.]+)$/.exec(section);
      if (!m) continue;
      const rawId = m[1].replace(/^["']|["']$/g, '');
      const baseUrl = typeof kv.base_url === 'string' ? kv.base_url.trim() : '';
      if (!baseUrl) continue;   /* 没端点认不出是什么, 不猜 */

      const envName = typeof kv.env_key === 'string' ? kv.env_key.trim() : '';
      /* 极少数配置直接把 Key 写字面量; 有就用, 优先级高于环境变量 */
      const literal = looksLikeKey(kv.api_key) ? String(kv.api_key).trim() : null;
      const resolved = literal ? null : (envName ? envLookup.get(envName) : null);
      const key = literal ?? resolved?.value ?? null;
      const protocol = protocolFromWireApi(kv.wire_api, baseUrl);

      out.push({
        id: normalizeId(rawId),
        name: typeof kv.name === 'string' && kv.name.trim() ? kv.name.trim() : rawId,
        source: 'Codex',
        sourcePath: literal || !resolved ? file : `${file} + ${resolved.from}`,
        protocol,
        baseUrl,
        urlSuffix: SUFFIX_BY_PROTOCOL[protocol],
        hasKey: !!key,
        keyOrigin: literal ? 'config' : (resolved?.origin ?? null),
        keyEnvName: envName || undefined,
        keyPreview: key ? maskKey(key) : null,
        alreadyImported: false,
        apiKey: key ?? undefined,
      });
    }
  }

  /* auth.json: auth_mode=apikey 时 OPENAI_API_KEY 有值; chatgpt 登录模式下是 null,
   * 那种情况下 Codex 用的是 OAuth token —— **不导**, 那是 ChatGPT 订阅不是 BYOK, 搬过来也用不了。 */
  const authFile = path.join(home, '.codex', 'auth.json');
  const auth = readJson(authFile);
  if (auth && looksLikeKey(auth.OPENAI_API_KEY)) {
    out.push({
      id: 'openai',
      name: 'OpenAI',
      source: 'Codex',
      sourcePath: authFile,
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      urlSuffix: SUFFIX_BY_PROTOCOL.openai,
      hasKey: true,
      keyOrigin: 'config',
      keyPreview: maskKey(auth.OPENAI_API_KEY),
      alreadyImported: false,
      apiKey: String(auth.OPENAI_API_KEY).trim(),
    });
  }
}

function fromCcSwitch(home: string, out: ExternalProviderCandidate[]): void {
  const dir = path.join(home, '.cc-switch');
  try { if (!fs.existsSync(dir)) return; } catch { return; }

  const seen = new Set<string>();

  /** 从任意一坨对象里认出 "这是一个 Anthropic 兼容服务商" */
  const harvest = (node: unknown, sourcePath: string, depth = 0): void => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) harvest(item, sourcePath, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;

    /* env 段是 CC Switch 存 Claude Code 设置的地方 —— 跟 ~/.claude/settings.json 同构 */
    const env = (obj.env && typeof obj.env === 'object' ? obj.env : obj) as Record<string, unknown>;
    const baseUrl = [env.ANTHROPIC_BASE_URL, obj.baseUrl, obj.base_url, obj.url]
      .find((v) => typeof v === 'string' && /^https?:\/\//.test(v)) as string | undefined;
    const key = [env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY, obj.apiKey, obj.api_key, obj.token]
      .find((v) => looksLikeKey(v)) as string | undefined;

    if (baseUrl || key) {
      const rawName = [obj.name, obj.label, obj.title].find((v) => typeof v === 'string' && v.trim());
      const url = baseUrl ?? 'https://api.anthropic.com';
      let hostTag = 'ccswitch';
      try { hostTag = new URL(url).hostname.split('.')[0] || hostTag; } catch { /* 名字兜底 */ }
      const id = normalizeId(String(rawName ?? `ccswitch-${hostTag}`));
      const dedupeKey = `${id}|${url}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        out.push({
          id,
          name: String(rawName ?? `CC Switch (${hostTag})`),
          source: 'CC Switch',
          sourcePath,
          /* CC Switch 管的就是 Claude Code, 一律 anthropic 协议 */
          protocol: 'anthropic',
          baseUrl: url,
          urlSuffix: SUFFIX_BY_PROTOCOL.anthropic,
          hasKey: !!key,
          keyOrigin: key ? 'config' : null,
          keyPreview: key ? maskKey(key) : null,
          alreadyImported: false,
          apiKey: key,
        });
      }
    }

    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') harvest(value, sourcePath, depth + 1);
      /* 有的实现把整段配置当**字符串**存 (JSON in TEXT) —— 试着再解一层 */
      else if (typeof value === 'string' && value.length > 20 && value.trimStart().startsWith('{')) {
        try { harvest(JSON.parse(value), sourcePath, depth + 1); } catch { /* 不是 JSON 就算了 */ }
      }
    }
  };

  /* 1) 老版本: config.json */
  for (const name of ['config.json', 'cc-switch.json', 'providers.json']) {
    const file = path.join(dir, name);
    const json = readJson(file);
    if (json) harvest(json, file);
  }

  /* 2) 新版本: SQLite。表名列名都不押, 见函数头。 */
  const dbFile = path.join(dir, 'cc-switch.db');
  try {
    if (!fs.existsSync(dbFile)) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = createRequire(import.meta.url)('better-sqlite3');
    /* 只读 + immutable 语义: 绝不碰用户那份库, 它可能正被 CC Switch 打开着 */
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      ).all() as Array<{ name: string }>;
      for (const { name } of tables) {
        let rows: Array<Record<string, unknown>> = [];
        /* 加 LIMIT: 万一撞上一张几十万行的日志表, 不能把用户卡在这一屏 */
        try { rows = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}" LIMIT 500`).all(); } catch { continue; }
        for (const row of rows) harvest(row, `${dbFile} · ${name}`);
      }
    } finally {
      try { db.close(); } catch { /* noop */ }
    }
  } catch {
    /* 库读不了 (版本不兼容 / 被锁 / 没装 better-sqlite3) —— 这一源跳过, 其余照扫 */
  }
}

/** 环境变量 / shell profile 里的通用白名单 */
function fromEnv(envLookup: EnvLookup, out: ExternalProviderCandidate[]): void {
  for (const spec of ENV_PROVIDERS) {
    let hit: { value: string; origin: 'process-env' | 'dotenv' | 'shell-profile'; from: string } | null = null;
    let hitName = '';
    for (const n of spec.envNames) {
      const r = envLookup.get(n);
      if (r) { hit = r; hitName = n; break; }
    }
    if (!hit) continue;

    let baseUrl = spec.baseUrl;
    for (const bn of spec.baseUrlEnv ?? []) {
      const b = envLookup.get(bn);
      /* base_url 不是密钥, looksLikeKey 的长度判据对它同样够用 (URL 都比 12 长) */
      if (b) { baseUrl = b.value; break; }
    }

    out.push({
      id: spec.id,
      name: spec.name,
      source: 'Environment',
      sourcePath: hit.from,
      protocol: spec.protocol,
      baseUrl,
      urlSuffix: SUFFIX_BY_PROTOCOL[spec.protocol],
      hasKey: true,
      keyOrigin: hit.origin,
      keyEnvName: hitName,
      keyPreview: maskKey(hit.value),
      alreadyImported: false,
      apiKey: hit.value,
    });
  }
}

/* ── 入口 ─────────────────────────────────────────────────────────────── */

export interface DiscoverProvidersOptions {
  /** 已有的 Neox provider, 用来标 alreadyImported。给 { id, baseUrl } 列表。 */
  existing?: Array<{ id: string; baseUrl?: string }>;
  /**
   * 带上明文 Key。**默认 false** —— 只有主进程真正落盘那一刻才置 true,
   * 扫描给界面看的那一趟永远是 false。
   */
  includeSecrets?: boolean;
  /** 只给测试用 (本机的 ~/.codex 是真的, 造不出反例) */
  homeOverride?: string;
  /** 只给测试用 */
  envOverride?: NodeJS.ProcessEnv;
}

/**
 * 扫出所有可导入的 BYOK 候选。
 *
 *   **调用方必须是用户的一次显式动作** (点「检测」按钮 / 跑 `neox migrate --providers`)。
 *   不要挂到启动路径、不要挂到 onboarding 的自动扫描上。
 */
export function discoverExternalProviders(
  options: DiscoverProvidersOptions = {},
): ExternalProviderCandidate[] {
  const home = options.homeOverride ?? os.homedir();
  const envLookup = buildEnvLookup(home, options.envOverride ?? process.env);
  const out: ExternalProviderCandidate[] = [];

  try { fromClaudeSettings(home, out); } catch { /* 一类源坏了不该让整屏空掉 */ }
  try { fromCodex(home, envLookup, out); } catch { /* 同上 */ }
  try { fromCcSwitch(home, out); } catch { /* 同上 */ }
  try { fromEnv(envLookup, out); } catch { /* 同上 */ }

  /* 去重: 同一家在两处配过很常见 (Codex 的 openai-custom 和 OPENAI_API_KEY 是同一把)。
   * 判据是 (protocol + baseUrl) 而不是 id —— id 是各家自己起的名字, 端点才是同一性。
   * 先扫到的赢: 配置文件里的 > 环境变量里的 (前者带 name/model 等更多信息)。 */
  const seenEndpoint = new Set<string>();
  const seenId = new Set<string>();
  const existingIds = new Set((options.existing ?? []).map((p) => String(p.id).toLowerCase()));
  const existingEndpoints = new Set(
    (options.existing ?? [])
      .filter((p) => p.baseUrl)
      .map((p) => String(p.baseUrl).replace(/\/+$/, '').toLowerCase()),
  );

  const deduped: ExternalProviderCandidate[] = [];
  for (const c of out) {
    /* 判同一性只看**端点**, 不带协议。同一个 https://api.deepseek.com 会被
     * Codex 那条 (openai-responses) 和环境变量那条 (deepseek) 各认一次, 带上协议
     * 就成了两条 —— 界面上是同一个地址出现两遍, 用户只会以为我们扫重了。 */
    const endpoint = (c.baseUrl ?? '').replace(/\/+$/, '').toLowerCase();
    if (seenEndpoint.has(endpoint)) continue;
    seenEndpoint.add(endpoint);
    /* id 撞了就加后缀 —— 两家不同端点同名 (都叫 openai) 时不能互相覆盖 */
    if (seenId.has(c.id)) {
      let i = 2;
      while (seenId.has(`${c.id}-${i}`)) i++;
      c.id = `${c.id}-${i}`;
    }
    seenId.add(c.id);
    c.alreadyImported =
      existingIds.has(c.id.toLowerCase()) ||
      existingEndpoints.has((c.baseUrl ?? '').replace(/\/+$/, '').toLowerCase());
    if (!options.includeSecrets) delete c.apiKey;
    deduped.push(c);
  }

  /* 有 Key 的排前面 (用户一眼看到能直接用的), 同档按名字 */
  return deduped.sort((a, b) =>
    a.hasKey === b.hasKey ? a.name.localeCompare(b.name) : (a.hasKey ? -1 : 1));
}
