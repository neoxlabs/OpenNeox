
import {
  CONNECTOR_NAMESPACE_PATTERN,
  SIDE_EFFECTS,
  isCapabilityId,
  parseCapabilityId,
  satisfiesMinimum,
  type CapabilityId,
  type SideEffect,
} from '@neoxlabs/platform/shared/plugin-connector.js';

const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,48}$/;

function isLocalized(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  if (typeof t.en !== 'string' || !t.en.trim()) return false;
  if (t.zh !== undefined && typeof t.zh !== 'string') return false;
  return true;
}

/**
 * 校验清单里的 `connector` 块。
 *
 *   返回的 errors 会被 pluginSecurity.validateManifest 并进整体结果 —— 所以
 *   路径前缀统一写成 `connector.xxx`, 用户在一条错误里就能定位。
 */
export function validateConnector(raw: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const bad = (path: string, message: string) => errors.push(`connector.${path}: ${message}`);

  if (!raw || typeof raw !== 'object') {
    return { errors: ['connector must be an object'], warnings };
  }
  const c = raw as Record<string, any>;

  // ── 命名空间 ──────────────────────────────────────────────────────────
  if (typeof c.namespace !== 'string' || !CONNECTOR_NAMESPACE_PATTERN.test(c.namespace)) {
    bad('namespace', 'must be lowercase letters/digits/underscore, 2-31 chars (it prefixes every tool name)');
  }

  // ── baseUrl ──────────────────────────────────────────────────────────
  if (typeof c.baseUrl !== 'string' || !/^https:\/\//.test(c.baseUrl)) {
    bad('baseUrl', 'must be an https URL');
  } else {
    /* 默认禁止 host 里出现 `{{}}`: 连接表被写脏就会把 token 打到别的源。
     * Zendesk / Shopify 这类必须带子域的, 清单要同时声明 allowedHostSuffix,
     * 且 host 只能是「一个 connection 字段 + 这个字面量后缀」。 */
    const host = /^https:\/\/([^/]*)/.exec(c.baseUrl)?.[1] ?? '';
    const suffix = typeof c.allowedHostSuffix === 'string'
      ? c.allowedHostSuffix.trim().toLowerCase()
      : '';
    if (host.includes('{{')) {
      if (!suffix || !/^[a-z0-9][a-z0-9.-]{0,126}\.[a-z]{2,24}$/.test(suffix) || suffix.includes('{{')) {
        bad('allowedHostSuffix', 'required when the host has a placeholder — a literal suffix like zendesk.com');
      } else {
        const pinned = /^(\{\{\s*connection\.[a-zA-Z][a-zA-Z0-9_]{0,31}\s*\}\})\.(.+)$/.exec(host);
        if (!pinned || pinned[2].toLowerCase() !== suffix) {
          bad('baseUrl', `host placeholder must be a single connection field followed by .${suffix}`);
        }
      }
    } else if (c.allowedHostSuffix !== undefined && c.allowedHostSuffix !== '') {
      bad('allowedHostSuffix', 'only valid when the baseUrl host contains a connection placeholder');
    }
  }

  // ── auth ─────────────────────────────────────────────────────────────
  const auth = c.auth;
  if (!auth || typeof auth !== 'object' || typeof auth.kind !== 'string') {
    bad('auth', 'is required and must declare a kind (oauth2 | token | none)');
  } else if (auth.kind === 'oauth2') {
    for (const field of ['authorizeUrl', 'tokenUrl'] as const) {
      if (typeof auth[field] !== 'string' || !/^https:\/\//.test(auth[field])) {
        bad(`auth.${field}`, 'must be an https URL');
      }
    }
    if (!Array.isArray(auth.scopes) || auth.scopes.length === 0) {
      bad('auth.scopes', 'must list at least one scope');
    }
    if (auth.redirectUri !== undefined) {
      if (typeof auth.redirectUri !== 'string' || !/^https:\/\/[^\s]+$/.test(auth.redirectUri)) {
        bad('auth.redirectUri', 'must be an https URL registered with the provider');
      }
    }
    if (auth.loopbackPort !== undefined) {
      if (!Number.isInteger(auth.loopbackPort) || auth.loopbackPort < 1 || auth.loopbackPort > 65535) {
        bad('auth.loopbackPort', 'must be an integer port 1-65535');
      }
    }
  } else if (auth.kind === 'token') {
    const pathInject = auth.pathInject === true;
    const queryParam = typeof auth.queryParam === 'string' ? auth.queryParam.trim() : '';
    if (!pathInject && !queryParam && (typeof auth.header !== 'string' || !auth.header.trim())) {
      bad('auth.header', 'is required — the header name the token goes into (or set pathInject / queryParam)');
    }
    if (pathInject && auth.header && typeof auth.header !== 'string') {
      bad('auth.header', 'must be a string when present');
    }
    if (auth.queryParam !== undefined) {
      if (!queryParam || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(queryParam)) {
        bad('auth.queryParam', 'must be a query key (letters/digits/underscore/hyphen)');
      }
    }
    if (auth.valueTemplate !== undefined) {
      if (typeof auth.valueTemplate !== 'string' || !auth.valueTemplate.includes('{{token}}')) {
        bad('auth.valueTemplate', 'must contain {{token}}');
      }
    }
    if (auth.tokenEncoding !== undefined && auth.tokenEncoding !== 'plain' && auth.tokenEncoding !== 'base64') {
      bad('auth.tokenEncoding', 'must be plain or base64');
    }
    if (!isLocalized(auth.instructions)) {
      bad('auth.instructions', 'must be { en, zh? } — it tells the user where to get the token');
    }
  } else if (auth.kind !== 'none') {
    bad('auth.kind', 'must be one of: oauth2, token, none');
  }

  // ── 固定头 ───────────────────────────────────────────────────────────
  if (c.headers !== undefined) {
    if (typeof c.headers !== 'object' || c.headers === null) {
      bad('headers', 'must be an object of header name → value');
    } else {
      for (const [key, value] of Object.entries(c.headers)) {
        /* 凭据只能由宿主在闸门后注入 —— 清单里写死鉴权头就绕过了整个闸门 */
        if (/^(authorization|proxy-authorization|cookie)$/i.test(key)) {
          bad(`headers["${key}"]`, 'credentials are injected by the host — manifests must not set auth headers');
        }
        if (typeof value !== 'string') {
          bad(`headers["${key}"]`, 'must be a string');
        } else if (/[\r\n]/.test(value)) {
          bad(`headers["${key}"]`, 'must not contain CR/LF');
        } else if (/\{\{\s*token\s*\}\}/.test(value)) {
          bad(`headers["${key}"]`, 'credentials are injected by the host — manifests must not put {{token}} in headers');
        }
      }
    }
  }

  // ── 权限 ─────────────────────────────────────────────────────────────
  const declared = new Map<CapabilityId, SideEffect>();
  if (!Array.isArray(c.permissions) || c.permissions.length === 0) {
    bad('permissions', 'must declare at least one capability');
  } else {
    c.permissions.forEach((p: any, i: number) => {
      const at = `permissions[${i}]`;
      if (!p || typeof p !== 'object') { bad(at, 'must be an object'); return; }

      if (typeof p.capability !== 'string' || !isCapabilityId(p.capability)) {
        bad(`${at}.capability`, `invalid capability id: ${JSON.stringify(p.capability)}`);
        return;
      }
      if (!SIDE_EFFECTS.includes(p.effect)) {
        bad(`${at}.effect`, `must be one of: ${SIDE_EFFECTS.join(', ')}`);
        return;
      }

      /* 低报拦截 —— 市场最典型的提权路径之一 */
      const parsed = parseCapabilityId(p.capability)!;
      if (!satisfiesMinimum(parsed.verb, p.effect)) {
        bad(
          `${at}.effect`,
          `"${p.capability}" understates its side effect: "${p.effect}" is below the minimum required by verb "${parsed.verb}"`,
        );
      }

      if (!isLocalized(p.reason)) {
        bad(`${at}.reason`, 'is required — the install screen shows this to the user, not the scope string');
      }
      if (p.effect === 'costly' && (!p.cost || typeof p.cost.approxUsd !== 'number')) {
        bad(`${at}.cost`, 'costly capabilities must declare cost.approxUsd for the budget gate');
      }

      if (declared.has(p.capability)) {
        bad(`${at}.capability`, `duplicate declaration of "${p.capability}"`);
      }
      declared.set(p.capability, p.effect);
    });
  }

  // ── operations ───────────────────────────────────────────────────────
  const implemented = new Set<string>();
  if (!Array.isArray(c.operations) || c.operations.length === 0) {
    bad('operations', 'must declare at least one operation');
  } else {
    c.operations.forEach((op: any, i: number) => {
      const at = `operations[${i}]`;
      if (!op || typeof op !== 'object') { bad(at, 'must be an object'); return; }

      if (!isCapabilityId(op.capability)) {
        bad(`${at}.capability`, `invalid capability id: ${JSON.stringify(op.capability)}`);
      } else if (!declared.has(op.capability)) {
        bad(`${at}.capability`, `"${op.capability}" is not declared in connector.permissions`);
      } else {
        if (implemented.has(op.capability)) {
          bad(`${at}.capability`, `duplicate operation for "${op.capability}" — one operation per capability`);
        }
        implemented.add(op.capability);
      }

      if (!METHODS.has(op.method)) {
        bad(`${at}.method`, `must be one of: ${[...METHODS].join(', ')}`);
      }
      if (typeof op.path !== 'string' || !op.path.startsWith('/')) {
        bad(`${at}.path`, 'must be a path starting with /');
      } else if (op.path.includes('{{token}}') && auth?.kind === 'token' && auth.pathInject !== true) {
        bad(`${at}.path`, '{{token}} in the path requires auth.pathInject: true — the host injects the credential after the gate');
      } else if (op.path.includes('{{token}}') && auth?.kind !== 'token') {
        bad(`${at}.path`, '{{token}} is only valid for token auth with pathInject');
      }
      if (op.query !== undefined && (typeof op.query !== 'object' || op.query === null)) {
        bad(`${at}.query`, 'must be an object of param → template');
      }
    });
  }

  // ── tools (Agent 看得见的那一层) ──────────────────────────────────────
  const seenToolNames = new Set<string>();
  if (!Array.isArray(c.tools) || c.tools.length === 0) {
    bad('tools', 'must expose at least one tool — a connector no agent can call is dead weight');
  } else {
    c.tools.forEach((t: any, i: number) => {
      const at = `tools[${i}]`;
      if (!t || typeof t !== 'object') { bad(at, 'must be an object'); return; }

      if (typeof t.name !== 'string' || !TOOL_NAME_PATTERN.test(t.name)) {
        bad(`${at}.name`, 'must be lowercase letters/digits/underscore starting with a letter');
      } else if (seenToolNames.has(t.name)) {
        bad(`${at}.name`, `duplicate tool name "${t.name}"`);
      } else {
        seenToolNames.add(t.name);
      }

      if (!isLocalized(t.description)) {
        bad(`${at}.description`, 'must be { en, zh? } — the model reads this to decide when to call it');
      }

      if (!isCapabilityId(t.capability)) {
        bad(`${at}.capability`, `invalid capability id: ${JSON.stringify(t.capability)}`);
      } else if (!declared.has(t.capability)) {
        bad(`${at}.capability`, `"${t.capability}" is not declared in connector.permissions`);
      } else if (!implemented.has(t.capability)) {
        /* 声明了权限却没有 operation 实现 —— 工具挂上去也调不通 */
        bad(`${at}.capability`, `"${t.capability}" has no operation implementing it`);
      }

      if (t.input !== undefined && (typeof t.input !== 'object' || t.input === null)) {
        bad(`${at}.input`, 'must be a JSON Schema object');
      }
    });
  }

  // ── 声明了却没人用的权限: 不拦, 但要提醒 ─────────────────────────────
  for (const cap of declared.keys()) {
    if (!implemented.has(cap)) {
      warnings.push(`connector: capability "${cap}" is declared but no operation implements it`);
    }
  }

  if (c.connectionFields !== undefined) {
    if (!Array.isArray(c.connectionFields)) {
      bad('connectionFields', 'must be an array');
    } else {
      c.connectionFields.forEach((f: any, i: number) => {
        if (typeof f?.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(f.key)) {
          bad(`connectionFields[${i}].key`, 'must be an identifier');
        }
        if (!isLocalized(f?.label)) bad(`connectionFields[${i}].label`, 'must be { en, zh? }');
      });
    }
  }

  return { errors, warnings };
}
