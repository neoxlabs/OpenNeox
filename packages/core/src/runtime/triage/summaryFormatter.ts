export interface SummaryFormatInput {
  source: 'leader' | 'worker' | 'team';
  status?: 'accepted' | 'running' | 'completed' | 'failed';
  text: string;
}

export class AssistantSummaryFormatter {
  format(input: SummaryFormatInput): string {
    const body = input.text.trim() || this.defaultBody(input.source, input.status);

    if (input.status === 'accepted' || input.status === 'running') {
      return `收到，这件事我已经安排后台开始推进了。\n\n${body}`;
    }

    if (input.status === 'failed') {
      return `我已经跟到出错点了，先把目前确定的情况告诉你。\n\n${body}`;
    }

    if (input.source === 'leader' || input.source === 'team') {
      return `我这边已经把结果整理好了，你直接看重点就行：\n\n${body}`;
    }

    return `目前结果如下：\n\n${body}`;
  }

  private defaultBody(source: SummaryFormatInput['source'], status?: SummaryFormatInput['status']): string {
    if (status === 'failed') return '后台执行失败，需要重新检查。';
    if (source === 'leader' || source === 'team') return '后台团队已经完成本轮处理。';
    return '后台执行已完成。';
  }
}
