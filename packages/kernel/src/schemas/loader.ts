/**
 * Schema loader — startup-time loads all yamls from schemas/ into an indexed
 *   in-memory registry. Validates with zod (validate.ts). Throws on any error
 *   so a broken schema can't make it to prod.
 *
 *   Usage:
 *     import { loadSchemas } from '@openneox/kernel/schemas';
 *     const registry = await loadSchemas();
 *     const model = registry.resolveModel('claude-opus-4-8');
 *     const slug = registry.resolveUpstreamSlug('claude-opus-4-8', 'prov_openrouter', 'fast');
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  EffortLevel,
  FamilySchema,
  ModelSchema,
  ProtocolSchema,
  ProviderSchema,
  SchemaRegistry,
} from './types.js';
import { validateFamily, validateModel, validateProtocol, validateProvider } from './validate.js';
import { setModelVisionAuthority } from '../platform/modelCapabilities.js';
import { getBakedSchemas } from './bakedSchemas.generated.js';
import { canonicalizeSeparators, normalizeModelName, resolveModelName } from './modelLookup.js';

/** 一份 schema 源 = 子目录名 → (文件名 → yaml 原文). 磁盘目录和烘焙快照都归一成它, 下游只认这个形状。 */
type SchemaSource = { origin: string; read: (subdir: string) => Array<{ name: string; text: string }> };

function diskSource(dir: string): SchemaSource {
  return {
    origin: dir,
    read: (subdir) => {
      const full = path.join(dir, subdir);
      if (!fs.existsSync(full)) return [];
      return fs
        .readdirSync(full)
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .map((name) => ({ name, text: fs.readFileSync(path.join(full, name), 'utf-8') }));
    },
  };
}

function bakedSource(): SchemaSource {
  const snapshot = getBakedSchemas();
  return {
    origin: '<baked: scripts/bake-schemas.mjs>',
    read: (subdir) =>
      Object.entries(snapshot[subdir] ?? {}).map(([name, text]) => ({ name, text })),
  };
}

/** schema 源选取. 优先级:
 *    1. NEOX_SCHEMAS_DIR — 显式覆盖 (bench / 运维挂载). 设了但不存在 = 配置错, **直接抛**, 不偷偷往下走。
 *    2. 磁盘 schemas/ — dev 场景, 改 yaml 立即生效不用重 build。
 *    3. 烘焙快照 — 发行版唯一可用的一份 (Electron asar 内 / bun --compile 单文件),
 *       内容由 build 时 scripts/bake-schemas.mjs 从同一份 yaml 生成, 与磁盘等价而非降级。
 *  三者全空才抛。注意: 这里没有"找不到就用内置默认值"的降级路径 —— schema 缺失一律 fail-loud。 */
function resolveSchemaSource(): SchemaSource {
  const env = process.env.NEOX_SCHEMAS_DIR;
  if (env) {
    if (!fs.existsSync(env)) {
      throw new Error(`[schemas] NEOX_SCHEMAS_DIR="${env}" 指向的目录不存在 — 拒绝静默回落, 请修正或删掉该变量.`);
    }
    return diskSource(env);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'schemas'),
    path.resolve(here, '../../../../../schemas'),
    path.resolve(here, '../../../../schemas'),
    path.resolve(here, '../../../schemas'),
  ];
  for (const c of candidates) {
    /* 目录存在还不够: 必须真有 models/ 才算 (防 cwd 底下恰好有个同名空 schemas/ 抢走优先级) */
    if (fs.existsSync(path.join(c, 'models'))) return diskSource(c);
  }
  const baked = bakedSource();
  if (baked.read('models').length > 0) return baked;
  throw new Error(
    `[schemas] 没有可用的 schema 源: 磁盘 schemas/ 找不到, 烘焙快照也是空的. ` +
      `dev 请从 repo 根跑或设 NEOX_SCHEMAS_DIR; 发行版说明 build 漏跑 scripts/bake-schemas.mjs.`,
  );
}

function readYamlDir<T>(
  source: SchemaSource,
  subdir: string,
  validator: (raw: unknown) => T,
): Map<string, T> {
  const entries: Map<string, T> = new Map();
  for (const { name, text } of source.read(subdir)) {
    const where = `${source.origin}/${subdir}/${name}`;
    const raw = yaml.load(text);
    let validated: T;
    try {
      validated = validator(raw);
    } catch (e: any) {
      throw new Error(`[schemas] validation failed in ${where}: ${e?.message ?? e}`);
    }
    const id = (validated as { id: string }).id;
    if (entries.has(id)) {
      throw new Error(`[schemas] duplicate id "${id}" in ${where}`);
    }
    entries.set(id, validated);
  }
  return entries;
}

export interface LoadSchemasOptions {
  dir?: string;
  /** When set, skips zod validation. CI / lint should keep it on. */
  skipValidation?: boolean;
}

export function loadSchemas(opts: LoadSchemasOptions = {}): SchemaRegistry {
  const source = opts.dir ? diskSource(opts.dir) : resolveSchemaSource();

  const protocols = readYamlDir<ProtocolSchema>(
    source, 'protocols',
    opts.skipValidation ? (r: any) => r : validateProtocol,
  );
  const providers = readYamlDir<ProviderSchema>(
    source, 'providers',
    opts.skipValidation ? (r: any) => r : validateProvider,
  );
  const models = readYamlDir<ModelSchema>(
    source, 'models',
    opts.skipValidation ? (r: any) => r : validateModel,
  );
  const families = readYamlDir<FamilySchema>(
    source, 'families',
    opts.skipValidation ? (r: any) => r : validateFamily,
  );

  /* 空 registry 是"看着绿实际全失效"的最坏形态 (CLI 丢 thinking 就长这样) —— fail-loud */
  if (models.size === 0 || families.size === 0) {
    throw new Error(
      `[schemas] source "${source.origin}" 读出 models=${models.size} families=${families.size} — ` +
        `schema registry 不允许为空.`,
    );
  }

  /* Cross-reference checks — fail fast in CI */
  for (const provider of providers.values()) {
    if (!protocols.has(provider.protocol)) {
      throw new Error(
        `[schemas] provider "${provider.id}" references unknown protocol "${provider.protocol}"`,
      );
    }
  }
  for (const model of models.values()) {
    if (Object.keys(model.upstream_slugs).length === 0) {
      throw new Error(`[schemas] model "${model.id}" has no upstream_slugs`);
    }
    for (const providerId of Object.keys(model.upstream_slugs)) {
      if (!providers.has(providerId)) {
        throw new Error(
          `[schemas] model "${model.id}" references unknown provider "${providerId}"`,
        );
      }
    }
  }

  /* family 识别索引 — alias 子串匹配 + name_regex.
     先把所有 family 的 aliases/regex 预编译到一张表, detectFamily 调用 O(K) 一遍走完。
     K = sum(aliases) + sum(name_regex), 当前 ~ 30, 一次调用微秒级。

      加固: 按 family.id 字母序排, 让 detectFamily 结果**确定可预测**
     (不依赖文件系统 readdir 顺序)。当前 aliases 互不交叉, 排序与否结果一样;
     但今后 alias 增多可能交叉, 排序至少给个明确的 tie-break。 */
  type FamilyMatcher = { family: FamilySchema; aliases: string[]; regexes: RegExp[] };
  const familyMatchers: FamilyMatcher[] = [...families.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((f) => ({
      family: f,
      aliases: f.aliases.map((a) => a.toLowerCase()),
      regexes: (f.name_regex ?? []).map((p) => new RegExp(p, 'i')),
    }));

  const detectFamily: SchemaRegistry['detectFamily'] = (input) => {
    const haystacks = [input.model, input.provider, input.protocol]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .map((s) => s.toLowerCase());
    if (haystacks.length === 0) return null;
    for (const m of familyMatchers) {
      for (const h of haystacks) {
        if (m.aliases.some((a) => h.includes(a))) return m.family;
        if (m.regexes.some((re) => re.test(h))) return m.family;
      }
    }
    return null;
  };

  /* Build lookup entries for model ids and declared upstream slugs. Normalized
   * candidates and version-safe substring matching accept provider paths and
   * common naming variants while exact model ids remain authoritative. */
  const lookupIndex = new Map<string, ModelSchema>();
  for (const m of models.values()) lookupIndex.set(m.id.toLowerCase(), m);
  for (const m of models.values()) {
    for (const slug of Object.values(m.upstream_slugs ?? {})) {
      if (typeof slug !== 'string' || !slug.trim()) continue;
      for (const key of [slug.toLowerCase(), normalizeModelName(slug), canonicalizeSeparators(normalizeModelName(slug))]) {
        if (key && !lookupIndex.has(key)) lookupIndex.set(key, m);
      }
    }
  }
  /* 归一化形态也进索引 (gpt-5.6-sol 本来就规范, 但 kimi-k2.7-code 这类要) */
  for (const m of models.values()) {
    for (const key of [normalizeModelName(m.id), canonicalizeSeparators(normalizeModelName(m.id))]) {
      if (key && !lookupIndex.has(key)) lookupIndex.set(key, m);
    }
  }
  const indexEntries = [...lookupIndex.entries()].map(([key, value]) => ({ key, value }));

  const registry: SchemaRegistry = {
    protocols,
    providers,
    models,
    families,
    resolveProtocol: (id) => protocols.get(id),
    resolveProvider: (id) => providers.get(id),
    /* 精确 → 归一化 → 版本安全子串 (见 modelLookup.ts)。
     * 原样 Map 查仍然排第一, 所以 yaml 里真有带冒号/斜杠的 id 也不会被误剥。 */
    resolveModel: (id) => models.get(id) ?? resolveModelName(
      id,
      (key) => lookupIndex.get(key),
      () => indexEntries,
    ),
    resolveFamily: (id) => families.get(id),
    detectFamily,
    resolveUpstreamSlug: (modelId, providerId, effort) => {
      const m = models.get(modelId);
      if (!m) return undefined;
      const effortOverride = effort && m.effort_map?.[effort]?.upstream_slug_override?.[providerId];
      return effortOverride ?? m.upstream_slugs[providerId];
    },
  };

  /* 把 yaml 声明注入 platform/modelCapabilities 的 vision 权威判定 —
     schemas/models 的 per-model vision (含 upstream slug 名) > schemas/families 的 family 默认。
     这样 runner 图片 fail-fast / 选择器徽标不再依赖 TEXT_ONLY 正则
     (glm-5.2/doubao-pro/qwen-3-max 等新视觉模型曾被正则误杀)。 */
  setModelVisionAuthority(buildVisionAuthority(registry));

  return registry;
}

function buildVisionAuthority(registry: SchemaRegistry): (model: string) => boolean | null {
  const byName = new Map<string, boolean>();
  for (const m of registry.models.values()) {
    const vision = m.capabilities?.vision;
    if (typeof vision !== 'boolean') continue;
    byName.set(m.id.toLowerCase(), vision);
    for (const slug of Object.values(m.upstream_slugs)) byName.set(slug.toLowerCase(), vision);
  }
  return (model: string): boolean | null => {
    const query = (model || '').trim().toLowerCase();
    if (!query) return null;
    const exact = byName.get(query);
    if (exact !== undefined) return exact;
    /* For variant names, the longest matching model declaration is the most
     * specific authority and therefore wins over shorter prefixes. */
    let best: { len: number; vision: boolean } | null = null;
    for (const [name, vision] of byName) {
      if (name.length >= 4 && query.includes(name) && (!best || name.length > best.len)) {
        best = { len: name.length, vision };
      }
    }
    if (best) return best.vision;
    const fam = registry.detectFamily({ model });
    return typeof fam?.capabilities?.vision === 'boolean' ? fam.capabilities.vision : null;
  };
}

/** Ensure the Node-side schema vision authority is initialized. Schema loading
 * errors propagate so invalid or missing packaged data remains observable. */
export function ensureSchemaVisionAuthority(): void {
  getSchemaRegistry();
}

/** 单例 — 多数调用方共享同一份, 启动期加载一次. */
let cached: SchemaRegistry | null = null;
export function getSchemaRegistry(): SchemaRegistry {
  if (cached) return cached;
  cached = loadSchemas();
  return cached;
}

/** Test / Phase-2 适配器在重启 dev server 时强制重 load. */
export function resetSchemaRegistryForTesting(): void {
  cached = null;
  setModelVisionAuthority(null);
}
