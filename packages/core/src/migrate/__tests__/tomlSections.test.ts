/**
 * Codex config.toml 的 [mcp_servers.*] 解析。
 *
 * 用例全部照着**真实文件**的形状写 (本机 ~/.codex/config.toml 里那三段):
 *   一个 stdio + args + enabled=false, 一个 stdio 带路径含空格, 一个纯 url。
 */
import { describe, it, expect } from 'vitest';
import { parseTomlSections } from '../tomlSections.js';

describe('parseTomlSections', () => {
  it('解析真实形状的 mcp_servers 段', () => {
    const s = parseTomlSections(`
[mcp_servers.computer-use]
args = [ "mcp" ]
command = "./Codex Computer Use.app/Contents/MacOS/Client"
cwd = "."
enabled = false

[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"
`);
    expect(s.get('mcp_servers.computer-use')).toEqual({
      args: ['mcp'],
      command: './Codex Computer Use.app/Contents/MacOS/Client',
      cwd: '.',
      enabled: false,
    });
    expect(s.get('mcp_servers.openaiDeveloperDocs')).toEqual({
      url: 'https://developers.openai.com/mcp',
    });
  });

  it('行尾注释要去掉, 但引号里的 # 不能动 (URL 锚点 / 路径里 # 很正常)', () => {
    const s = parseTomlSections(`
[x]
url = "https://a.example/mcp#frag"   # 这是注释
plain = "no comment here"
`);
    expect(s.get('x')!.url).toBe('https://a.example/mcp#frag');
    expect(s.get('x')!.plain).toBe('no comment here');
  });

  it('数组里带逗号的字符串不能被切开', () => {
    const s = parseTomlSections(`
[x]
args = [ "--flag", "a,b", "c" ]
`);
    expect(s.get('x')!.args).toEqual(['--flag', 'a,b', 'c']);
  });

  it('env 子表单独成段, 不会混进父段', () => {
    const s = parseTomlSections(`
[mcp_servers.foo]
command = "run"
[mcp_servers.foo.env]
TOKEN = "secret"
`);
    expect(s.get('mcp_servers.foo')).toEqual({ command: 'run' });
    expect(s.get('mcp_servers.foo.env')).toEqual({ TOKEN: 'secret' });
  });

  it('读不懂的行跳过而不是抛 —— 宁可少认一个 server, 不要猜错一条要执行的命令', () => {
    const s = parseTomlSections(`
[x]
multiline = """
不支持的多行
"""
good = "kept"
weird
`);
    expect(s.get('x')!.good).toBe('kept');
    expect(s.get('x')).not.toHaveProperty('weird');
  });

  it('literal string (单引号) 不做转义', () => {
    const s = parseTomlSections(`
[x]
p = 'C:\\Users\\n'
`);
    expect(s.get('x')!.p).toBe('C:\\Users\\n');
  });
});
