import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PROVIDER_PRESETS } from '@neoxlabs/kernel/models/providerPresets.js';

describe('provider preset 资产完整性', () => {
  it('每个 preset 都有同名 logo 文件', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const have = new Set(
      readdirSync(join(here, '../../../../assets/provider-logos'))
        .filter((f) => /\.(png|svg)$/i.test(f))
        .map((f) => f.replace(/\.(png|svg)$/i, '')),
    );
    const missing = PROVIDER_PRESETS.filter((p) => !have.has(p.id)).map((p) => p.id);
    expect(missing).toEqual([]);
  });

  it('opencode 必须配 openai 协议 —— 实测 25/35 通, 走 anthropic 只有 13/35', () => {
    const oc = PROVIDER_PRESETS.find((p) => p.id === 'opencode');
    expect(oc).toBeTruthy();
    expect(oc!.capabilities.find((c) => c.modality === 'chat')?.protocol).toBe('openai');
    /* openai 协议下我们不补版本段, baseUrl 必须自带 /v1, 否则打到人家官网拿回 404 HTML */
    expect(oc!.baseUrl.endsWith('/v1')).toBe(true);
  });
});
