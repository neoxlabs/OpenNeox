import { describe, expect, it } from 'vitest';
import { glanceSession } from '../sessionGlance';

describe('glanceSession — 工作台卡片 / 全景墙的会话摘要', () => {
  it('ask_user 没答 → 等你 (ask), 带问题原文', () => {
    const g = glanceSession([
      { type: 'user_message', detail: '做 PPT', timestamp: 1 },
      { type: 'ask_user', pending: true, askUserStatus: 'waiting', askUserQuestions: [{ question: '封面用哪张图？' }], timestamp: 2 },
    ]);
    expect(g.waiting).toEqual({ kind: 'ask', text: '封面用哪张图？' });
  });

  it('工具调用等批准 → 等你 (approval)', () => {
    const g = glanceSession([{ type: 'tool_call', awaitingApproval: true, title: '执行 rm -rf dist', timestamp: 3 }]);
    expect(g.waiting?.kind).toBe('approval');
  });

  it('助手最后一句是问句 → 软信号 question; 已答过的 ask_user 不算', () => {
    const g = glanceSession([
      { type: 'ask_user', askUserStatus: 'answered', timestamp: 1 },
      { type: 'tool_call', title: '🔧 mvn compile', timestamp: 2 },
      { type: 'assistant_message', detail: '编译通过了。\n\n要我顺便把测试也跑一遍吗？', timestamp: 3 },
    ]);
    expect(g.waiting).toEqual({ kind: 'question', text: '要我顺便把测试也跑一遍吗？' });
    expect(g.activity).toBe('mvn compile');
    expect(g.lastLine).toBe('编译通过了。');
    expect(g.lastTs).toBe(3);
  });

  it('没干活的轮 (打招呼) 问号结尾不算等你', () => {
    const g = glanceSession([
      { type: 'user_message', detail: '你好', timestamp: 1 },
      { type: 'assistant_message', detail: '你好！有什么可以帮你的吗？', timestamp: 2 },
    ]);
    expect(g.waiting).toBeNull();
  });

  it('activity: 同一步并排的几条, 取还在跑的那条, 不取最后一条早跑完的', () => {
    const g = glanceSession([
      { type: 'user_message', detail: '构建一下', timestamp: 1 },
      { type: 'tool_call', title: '运行 npm run build', pending: true, timestamp: 2 },
      { type: 'tool_call', title: '运行 ls -la', pending: false, timestamp: 3 },
    ]);
    expect(g.activity).toBe('运行 npm run build');
  });

  it('普通收尾不算等你', () => {
    const g = glanceSession([{ type: 'assistant_message', detail: '## 做好了\n已导出 8 页。', timestamp: 5 }]);
    expect(g.waiting).toBeNull();
    expect(g.lastLine).toBe('做好了');
  });
  it('outputs: 只收给人看的成品文件, 新的在前, 去重, 最多 3 个', () => {
    const g = glanceSession([
      { type: 'edit_file', editFilePath: '/p/src/a.ts', timestamp: 1 },
      { type: 'tool_call', toolName: 'write_file', targetPath: '/p/out/report.docx', timestamp: 2 },
      { type: 'file_stream', filePath: '/p/out/q3.pptx', timestamp: 3 },
      { type: 'file_stream', filePath: '/p/out/q3.pptx', timestamp: 4 },
      { type: 'tool_call', toolName: 'write_file', targetPath: '/p/out/fail.xlsx', success: false, timestamp: 5 },
      { type: 'tool_call', toolName: 'generate_image', targetPath: '/p/out/cover.png', timestamp: 6 },
      { type: 'tool_call', toolName: 'read_file', targetPath: '/p/out/old.pdf', timestamp: 7 },
    ]);
    expect(g.outputs.map((o) => o.ext)).toEqual(['png', 'pptx', 'docx']);
  });
});
