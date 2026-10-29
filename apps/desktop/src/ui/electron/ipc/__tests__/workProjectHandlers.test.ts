import { describe, expect, it, vi } from 'vitest';

vi.mock('../ipcMainBridged.js', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('@neoxlabs/platform/platform/database.js', () => ({ getDatabase: vi.fn() }));
vi.mock('@neoxlabs/core/runtime/modeHome.js', () => ({ ensureModeHome: () => '/tmp/neox-work', getModeHomeDir: () => '/tmp/neox-work' }));

const { cleanProjectName, composeInstructions, cleanProfile } = await import('../workProjectHandlers');

describe('cleanProjectName', () => {
  it('去掉文件名不认的字符和开头的点, 最多 40 字', () => {
    expect(cleanProjectName('  ..咖啡店/运营:2026  ')).toBe('咖啡店 运营 2026');
    expect(cleanProjectName('a'.repeat(60))).toHaveLength(40);
    expect(cleanProjectName('///')).toBe('');
  });
});

describe('composeInstructions', () => {
  it('说明 + 资料清单, 告诉 agent 资料在哪', () => {
    const text = composeInstructions('咖啡店运营', '金额用万元', '/w/咖啡店运营/资料', [
      { name: '菜单价格表.xlsx', path: '/w/咖啡店运营/资料/菜单价格表.xlsx', isDir: false, mtime: 0 },
      { name: '门店照片', path: '/w/咖啡店运营/资料/门店照片', isDir: true, count: 12, mtime: 0 },
    ]);
    expect(text).toContain('# 项目：咖啡店运营');
    expect(text).toContain('金额用万元');
    expect(text).toContain('/w/咖啡店运营/资料');
    expect(text).toContain('- 菜单价格表.xlsx');
    expect(text).toContain('- 门店照片/');
  });
  it('没写说明只有资料时不出「项目说明」一节', () => {
    expect(composeInstructions('x', '  ', '/w/x/资料', [{ name: 'a.pdf', path: '', isDir: false, mtime: 0 }])).not.toContain('## 项目说明');
  });

  /* work:Q-11 —— 项目口径四项写进给 agent 看的那份, 标 source=project */
  it('项目口径: 受众/口吻/模板/禁写项都写进去, 并标明来自项目设定', () => {
    const text = composeInstructions('咖啡店运营', '', '/w/咖啡店运营/资料', [], {
      audience: '加盟商和店长',
      tone: '务实, 不用形容词',
      template: '照 2026 春季周报的版式',
      forbidden: '不写「保证」「第一」这类绝对化说法',
    });
    expect(text).toContain('## 项目口径');
    expect(text).toContain('- 受众：加盟商和店长');
    expect(text).toContain('- 口吻：务实, 不用形容词');
    expect(text).toContain('- 模板：照 2026 春季周报的版式');
    expect(text).toContain('- 禁写：不写「保证」「第一」这类绝对化说法');
    expect(text).toContain('source=project');
    expect(text).toContain('不要再问用户');
  });
  it('口径全空时不出这一节; 只填一项时只写那一项', () => {
    expect(composeInstructions('x', '', '/w/x/资料', [], {})).not.toContain('## 项目口径');
    const one = composeInstructions('x', '', '/w/x/资料', [], { audience: '老板' });
    expect(one).toContain('- 受众：老板');
    expect(one).not.toContain('- 口吻：');
  });
});

describe('cleanProfile', () => {
  it('去空白/换行, 只留填了的项, 每项最多 200 字', () => {
    expect(cleanProfile({ audience: '  老板 \n', tone: '', template: undefined })).toEqual({ audience: '老板' });
    expect(cleanProfile({})).toBeUndefined();
    expect(cleanProfile(null)).toBeUndefined();
    expect(cleanProfile({ tone: 'a'.repeat(260) })!.tone).toHaveLength(200);
  });
});
