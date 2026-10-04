import { describe, it, expect } from 'vitest';
import { parseToolArguments } from '../toolArgsParser';

/**
 *  call_tool 转发可能产生未加引号的标识符值；测试验证修复链能处理值位置的非标准 JSON。
 */
describe('裸标识符值', () => {
  it('call_tool 的 name 没加引号也能救回来', () => {
    const r = parseToolArguments('{"name": search_files, "args": {"pattern": "*.ts"}}', 'call_tool');
    expect(r.ok).toBe(true);
    expect(r.args.name).toBe('search_files');
    expect((r.args.args as any).pattern).toBe('*.ts');
  });

  it('数字和布尔不能被修成字符串 —— 那是把类型悄悄改掉', () => {
    const r = parseToolArguments('{"limit": 10, "deep": true, "who": null, "mode": append}');
    expect(r.ok).toBe(true);
    expect(r.args.limit).toBe(10);
    expect(r.args.deep).toBe(true);
    expect(r.args.who).toBe(null);
    expect(r.args.mode).toBe('append');
  });

  it('本来就合法的 JSON 不走修复', () => {
    const r = parseToolArguments('{"path": "a.ts"}');
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(false);
  });
});
