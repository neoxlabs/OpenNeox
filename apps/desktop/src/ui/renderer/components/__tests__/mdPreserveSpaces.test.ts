import { describe, expect, it } from 'vitest';
import { normalizeLooseLists } from '../normalizeLooseLists';
import { fenceBareJson } from '../../modules/agent-timeline/fenceBareJson';
import { escapeUnknownHtmlTags } from '../escapeUnknownHtmlTags';

const RAW = [
  '权限确实是 `-rw-------`（600 root），当前用户读不了。这是注入脚本的 bug（临时文件 600 模式直接 replace）。你现在在终端执行这条带空格的命令：',
  '',
  '```bash',
  'sudo chmod 644 "/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js"',
  '```',
  '',
  '执行后终端会显示（无报错即成功）。然后告诉我，我立刻重启 Cursor 验证 fable5。',
].join('\n');

describe('markdown 预处理不许吃掉空格', () => {
  it('三步预处理逐一保留 chmod 644 的空格', () => {
    const a = normalizeLooseLists(RAW);
    expect(a, 'normalizeLooseLists 吃掉了空格').toContain('chmod 644');
    const b = fenceBareJson(a);
    expect(b, 'fenceBareJson 吃掉了空格').toContain('chmod 644');
    const c = escapeUnknownHtmlTags(b);
    expect(c, 'escapeUnknownHtmlTags 吃掉了空格').toContain('chmod 644');
    expect(c, '正文里的 CJK/数字边界空格也不许动').toContain('临时文件 600 模式');
    expect(c, 'Latin/CJK 边界空格也不许动').toContain('Cursor 验证');
  });
});
