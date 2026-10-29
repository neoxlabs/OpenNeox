import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../imageGenTools.ts'),
  'utf8',
);

describe('图片模型前置条件', () => {
  it('不存在"编一个云端模型当默认值"的兜底常量', () => {
    expect(src).not.toMatch(/FALLBACK_DEFAULT_MODEL/);
    /* 订阅专属模型 id 不许再作为默认值出现在代码里 (注释里解释历史可以) */
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/['"]gpt-image-[12]['"]/);
  });

  it('defaultModel 可以是 null —— 没有就是没有', () => {
    expect(src).toMatch(/defaultModel:\s*string\s*\|\s*null/);
    expect(src).toMatch(/const defaultModel: string \| null = cloud\[0\] \?\? byok\[0\] \?\? null;/);
  });

  it('generate_image / edit_image 都先过闸再发请求', () => {
    const gates = src.match(/resolveImageModel\('(generate|edit)_image'/g) ?? [];
    expect(gates.sort()).toEqual(["resolveImageModel('edit_image'", "resolveImageModel('generate_image'"]);
    /* 闸必须真的能拦住 —— 只算不返回等于没闸 */
    expect((src.match(/if \('blocked' in picked\) return picked\.blocked;/g) ?? []).length).toBe(2);
  });

  it('拦下来的是 precondition 而不是故障 (界面不弹红卡, 见 turnAnomaly.isToolGuidanceEntry)', () => {
    expect(src).toMatch(/precondition: true/);
    expect(src).toMatch(/no_image_model_configured/);
  });

  it('给模型的话要把两条开通路径都说清楚, 并且明确别重试', () => {
    expect(src).toMatch(/Settings → Providers/);
    expect(src).toMatch(/subscription model/i);
    expect(src).toMatch(/instead of retrying/i);
  });
});
