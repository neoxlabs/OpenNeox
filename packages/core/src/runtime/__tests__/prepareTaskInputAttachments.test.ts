import { describe, it, expect } from 'vitest';
import { prepareTaskInputText } from '../agentRuntimeHostHelpers';

describe('prepareTaskInputText 附件路径', () => {
  it('解析过的文档带 path; 读不出文字的文件只给 path; 图片给 path', () => {
    const out = prepareTaskInputText('处理一下', {
      attachments: [
        { id: '1', type: 'file', data: '', name: '预算.xlsx', fileId: 'a'.repeat(64), chars: 100, path: '/ws/uploads/预算.xlsx' },
        { id: '2', type: 'file', data: '', name: '资料.zip', path: '/ws/uploads/资料.zip', status: 'saved' },
        { id: '3', type: 'image', data: 'data:image/png;base64,AQID', name: 'p.png', path: '/ws/uploads/p.png' },
      ],
    } as any);
    expect(out).toContain('path=/ws/uploads/预算.xlsx');
    expect(out).toContain('[已上传文件: 资料.zip] (path=/ws/uploads/资料.zip)');
    expect(out).toContain('[已上传图片: p.png] (path=/ws/uploads/p.png)');
  });

  it('图片没 path (桌面粘贴的截图) 不加多余行', () => {
    const out = prepareTaskInputText('看图', {
      attachments: [{ id: '1', type: 'image', data: 'data:image/png;base64,AQID', name: 'p.png' }],
    } as any);
    expect(out).toBe('看图');
  });
});
