
interface AppNote {
  match: RegExp;
  note: string;
}

const APP_NOTES: AppNote[] = [
  {
    match: /wps|wpp|演示文稿|表格|文字文稿/i,
    note: 'WPS on Windows: Writer/Presentation/Spreadsheet share wps.exe, so target the DOCUMENT window title '
      + '(e.g. 「演示文稿1 - WPS 2019」); 「WPS 演示」/ wpp also resolve to the presentation window. '
      + 'Do not target the launcher 「WPS - WPS 2019」/「WPS 2019」. If the document is behind the home window, '
      + 'launch/snapshot its title first so the bridge raises it. When a Save As dialog opens, stay on the WPS '
      + 'window — do not switch to explorer/Documents to finish it.',
  },
  {
    match: /wechat|微信|qq|飞书|lark|feishu|dingtalk|钉钉|企业微信|wecom/i,
    note: 'Chat apps: conversation rows often show up as Text rather than Button — they are numbered and a click '
      + 'hits the row center. Small toolbar Images (图片/文件) are in the tree; click them by number. '
      + 'The unlabeled chevron next to 发送 is 「发送菜单」, not 发送.',
  },
];

export function appNotesFor(...apps: Array<string | undefined>): string | undefined {
  const text = apps.filter(Boolean).join(' ');
  if (!text) return undefined;
  const hits = APP_NOTES.filter((n) => n.match.test(text)).map((n) => n.note);
  return hits.length ? hits.join(' ') : undefined;
}
