import { describe, it, expect } from 'vitest';
import { parseSeenImages } from '../seenImagesContent';
import { parseInterruptSurvivors, detectSystemMessages, isBusEventMessage } from '../cells/systemMessageParsers';
describe('中断幸存进程 + 截断的看图标记', () => {
  it('salvage', () => {
    const marker = '__NEOX_SEEN_IMAGES__' + JSON.stringify({ images: [{ path: 'C:\\Users\\a\\.neox\\run\\seen\\ab.png', label: 'l' }], text: 'x'.repeat(50) });
    expect(parseSeenImages(marker.slice(0, 120))?.[0]?.path).toBe('C:\\Users\\a\\.neox\\run\\seen\\ab.png');
    const env = JSON.stringify({ content: marker, metadata: {} });
    expect(parseSeenImages(env.slice(0, 150))?.[0]?.path).toBe('C:\\Users\\a\\.neox\\run\\seen\\ab.png');
  });
  it('survivors', () => {
    const xml = '<background-processes-survived-interrupt>\n用户中断了上一轮。\n  - pid 24564: cd /d e:\\code && java -jar x.jar\n不要假设。\n</background-processes-survived-interrupt>';
    expect(isBusEventMessage(xml)).toBe(true);
    expect(detectSystemMessages(xml)[0]).toMatchObject({ kind: 'interrupt_survivors', data: { kind: 'processes', items: [{ pid: 24564 }] } });
  });
});
