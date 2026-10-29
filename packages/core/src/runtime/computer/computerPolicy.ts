/**
 * 每 App 授权 —— 用户自己钉的名单。
 *
 * 层次关系 (**只能越往上越严, 不能反过来**):
 *
 *     桥的硬线 (Guard.swift)     终端 / Neox 自己 / 系统授权窗 —— 永远拒, 配置改不动
 *          ↑
 *     这一层 (用户策略)          allowlist / deny 名单 —— 用户可以再收紧
 *          ↑
 *     审批档位                   dangerous 放行 / auto 弹卡 / manual 弹卡
 *
 * 为什么策略不能放开硬线: 一个能被配置关掉的安全边界等于没有边界。所以这里只做减法 ——
 * 硬线拒了的, 这里说什么都没用; 硬线放行的, 这里可以再拒。
 *
 * 配置放 `~/.neox/config.json` 的 `computerUse` 段 (跟别的设置同一个文件, 用户改一处):
 *
 *     "computerUse": {
 *       "policy": "open",            // open(默认) | allowlist
 *       "allow": ["Calculator", "com.tencent.xinWeChat"],
 *       "deny":  ["Mail", "com.apple.Safari"]
 *     }
 *
 * · open      —— 除了 deny 名单, 都能操作 (默认, 不改配置就是这个)
 * · allowlist —— 只有 allow 名单里的能操作。企业/谨慎用户用这个
 * deny 永远优先于 allow —— 同时写进两个名单时按"拒"算, 不按写的顺序算。
 *
 * 名字怎么比: 大小写不敏感, 且 **App 名和 bundleId 都认** —— 用户写 "微信" 或
 * "com.tencent.xinWeChat" 都该生效, 因为他两种都可能在别处见过。
 */

import { readFileSync } from 'node:fs';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';

export interface ComputerUsePolicy {
  policy: 'open' | 'allowlist';
  allow: string[];
  deny: string[];
}

const DEFAULT_POLICY: ComputerUsePolicy = { policy: 'open', allow: [], deny: [] };

/** 配置不常变, 但也不能永远缓存 (用户改完得生效) —— 跟插件闸同一个口径, 3 秒。 */
const CACHE_MS = 3000;
let cache: { at: number; value: ComputerUsePolicy } | null = null;

/** 纯函数 —— 好测, 且不碰磁盘 */
export function parseComputerUsePolicy(raw: unknown): ComputerUsePolicy {
  const cfg = (raw ?? {}) as { computerUse?: unknown };
  const cu = (cfg.computerUse ?? {}) as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [];
  return {
    policy: cu.policy === 'allowlist' ? 'allowlist' : 'open',
    allow: list(cu.allow),
    deny: list(cu.deny),
  };
}

export function readComputerUsePolicy(): ComputerUsePolicy {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value = DEFAULT_POLICY;
  try {
    value = parseComputerUsePolicy(JSON.parse(readFileSync(neoxHome('config.json'), 'utf8')));
  } catch {
    /* 配置读不了 / 不是 JSON —— 回默认的 open。
     * 刻意**不**在这里 fail-closed: 这一层是用户偏好, 不是安全边界 (安全边界在桥里),
     * 因为一个 JSON 语法错就让整个 CU 停摆, 代价远大于收益。 */
  }
  cache = { at: Date.now(), value };
  return value;
}

/** 一个目标是否匹配名单里的某一条 (App 名或 bundleId, 大小写不敏感) */
function hit(list: string[], target: string): boolean {
  const t = target.trim().toLowerCase();
  if (!t) return false;
  return list.some((raw) => {
    const e = raw.trim().toLowerCase();
    /* bundleId 允许前缀匹配 (com.mk.neox 覆盖 com.mk.neox.dev), 名字要求整体相等 ——
     * 名字做包含匹配会误伤 ("Mail" 会把 "Mailspring" 也拦了)。 */
    return e === t || (e.includes('.') && t.startsWith(e + '.'));
  });
}

export interface PolicyDenial {
  code: 'app_denied_by_policy' | 'app_not_in_allowlist';
  message: string;
}

/**
 * @param app 目标 App (名字或 bundleId)。不指定 = 前台应用, 这一层不判 (桥按真实前台判硬线)。
 */
export function checkComputerUsePolicy(app?: string, override?: ComputerUsePolicy): PolicyDenial | null {
  const target = (app ?? '').trim();
  if (!target) return null;
  const p = override ?? readComputerUsePolicy();

  /* deny 先判 —— 同时写进两个名单时按"拒"算 */
  if (hit(p.deny, target)) {
    return {
      code: 'app_denied_by_policy',
      message: `Refused: the user's Computer Use policy denies "${target}". `
        + 'This is a user setting (computerUse.deny in ~/.neox/config.json), not a bug — '
        + 'do something else, or tell the user which app you needed and why.',
    };
  }
  if (p.policy === 'allowlist' && !hit(p.allow, target)) {
    return {
      code: 'app_not_in_allowlist',
      message: `Refused: Computer Use is in allowlist mode and "${target}" is not on the list `
        + `(currently allowed: ${p.allow.length ? p.allow.join(', ') : 'nothing'}). `
        + 'Tell the user which app you needed — they can add it to computerUse.allow.',
    };
  }
  return null;
}

/** 测试用 —— 生产路径不该清缓存 */
export function __resetComputerPolicyCache(): void {
  cache = null;
}
