import { describe, it, expect } from 'vitest';
import { localizedDescription, allDescriptions } from '../localizedDescription.js';

const notion = {
  description: 'Read and write Notion pages',
  i18n: { zh: { description: '读写 Notion 页面' } },
};

describe('localizedDescription', () => {
  it('中文界面取 i18n.zh, 英文界面取主描述', () => {
    expect(localizedDescription(notion, 'zh')).toBe('读写 Notion 页面');
    expect(localizedDescription(notion, 'zh-CN')).toBe('读写 Notion 页面');
    expect(localizedDescription(notion, 'en')).toBe('Read and write Notion pages');
  });
  it('精确语言码优先于主语言', () => {
    const p = { description: 'x', i18n: { zh: { description: '简' }, 'zh-TW': { description: '繁' } } };
    expect(localizedDescription(p, 'zh-TW')).toBe('繁');
    expect(localizedDescription(p, 'zh-CN')).toBe('简');
  });
  it('老服务端只有 descriptionZh 时中文界面仍然用它', () => {
    expect(localizedDescription({ description: 'EN', descriptionZh: '中文' }, 'zh')).toBe('中文');
    expect(localizedDescription({ description: 'EN', descriptionZh: '中文' }, 'en')).toBe('EN');
  });
  it('什么都没有就回主描述, 再没有回空串', () => {
    expect(localizedDescription({ description: 'EN' }, 'ja')).toBe('EN');
    expect(localizedDescription({}, 'zh')).toBe('');
  });
});

describe('allDescriptions', () => {
  it('收齐所有语言 —— 英文界面搜中文词也能命中', () => {
    expect(allDescriptions(notion)).toEqual(['Read and write Notion pages', '读写 Notion 页面']);
  });
});
