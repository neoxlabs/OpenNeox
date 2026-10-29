
export interface SessionGlance {
  waiting: { kind: 'ask' | 'approval' | 'question'; text: string } | null;
  activity: string;
  lastLine: string;
  lastTs: number;
  /** 这个会话最近做出来的成品 (最多 3 个, 新的在前) —— 侧栏会话行右侧的缩略图 (UI 3.0) */
  outputs: Array<{ path: string; ext: string }>;
}

/** 算「成品」的扩展名: 给人看的文件 (文档 / 表格 / 演示 / 图片 / 视频 / 网页), 源码不算 */
const OUTPUT_EXT = new Set(['pptx', 'ppt', 'key', 'xlsx', 'xls', 'csv', 'docx', 'doc', 'pdf', 'md', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'mp4', 'mov', 'webm', 'mp3', 'wav']);

/** 从 timeline 尾部倒着收成品 (写出的给人看的文件), 新的在前、按路径去重 */
export function outputsOf(entries: ReadonlyArray<Record<string, any>>, max = 3): Array<{ path: string; ext: string; ts: number }> {
  const out: Array<{ path: string; ext: string; ts: number }> = [];
  const seen = new Set<string>();
  for (let i = entries.length - 1; i >= 0 && out.length < max; i--) {
    const e = entries[i];
    if (!e) continue;
    const writes = e.type === 'edit_file' || e.type === 'file_stream'
      || ((e.type === 'tool_call' || e.type === 'tool_result') && /write|create|export|save|generate_image|image_gen/i.test(String(e.toolName || '')));
    if (!writes || e.success === false) continue;
    const path = String(e.editFilePath || e.filePath || e.targetPath || '');
    const ext = (path.split('.').pop() || '').toLowerCase();
    if (!path || !OUTPUT_EXT.has(ext) || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, ext, ts: typeof e.timestamp === 'number' ? e.timestamp : 0 });
  }
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function cleanLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\d.\s]+/, '').replace(/[*_`]/g, '').trim())
    .filter((l) => l.length > 0);
}

function trailingQuestion(text: string): string | null {
  const lines = cleanLines(text);
  const last = lines[lines.length - 1] ?? '';
  if (!/[?？]\s*$/.test(last)) return null;
  const sentences = last.split(/(?<=[。.!！；;])\s*/);
  return clip(sentences[sentences.length - 1] || last, 60);
}

const MEANINGFUL = new Set(['assistant_message', 'user_message', 'ask_user', 'tool_call', 'tool_result', 'edit_file', 'file_stream']);

/** 最后一轮 (最后一条用户消息之后) 有没有真干活 —— 调过工具 / 改过文件。
 * 软信号只认干过活的轮: 打招呼的「有什么可以帮你的吗？」也是问号结尾, 不能算「等你」。 */
function lastTurnWorked(entries: ReadonlyArray<Record<string, any>>): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const t = entries[i]?.type;
    if (t === 'user_message') return false;
    if (t === 'tool_call' || t === 'tool_result' || t === 'edit_file' || t === 'file_stream') return true;
  }
  return false;
}

export function glanceSession(entries: ReadonlyArray<Record<string, any>>): SessionGlance {
  let waiting: SessionGlance['waiting'] = null;
  let activity = '';
  let lastLine = '';
  let lastTs = 0;
  let decided = false;

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || !MEANINGFUL.has(e.type)) continue;
    if (!lastTs && typeof e.timestamp === 'number') lastTs = e.timestamp;

    if (!decided) {
      decided = true;
      if (e.type === 'ask_user' && (e.askUserStatus === 'waiting' || (e.pending && e.askUserStatus !== 'answered'))) {
        const q = Array.isArray(e.askUserQuestions) ? e.askUserQuestions[0]?.question : '';
        waiting = { kind: 'ask', text: clip(String(q || e.title || ''), 60) };
      } else if (e.type === 'tool_call' && e.awaitingApproval) {
        waiting = { kind: 'approval', text: clip(String(e.title || e.toolName || ''), 60) };
      } else if (e.type === 'assistant_message' && typeof e.detail === 'string' && lastTurnWorked(entries)) {
        const q = trailingQuestion(e.detail);
        if (q) waiting = { kind: 'question', text: q };
      }
    }
    if (!activity && (e.type === 'tool_call' || e.type === 'edit_file' || e.type === 'file_stream') && typeof e.title === 'string') {
      activity = clip(e.title.replace(/^[^\p{L}\p{N}]+/u, ''), 48);
    }
    if (!lastLine && e.type === 'assistant_message' && typeof e.detail === 'string') {
      lastLine = clip(cleanLines(e.detail)[0] ?? '', 80);
    }
    if (decided && activity && lastLine) break;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === 'user_message') break;
    if (e && (e.type === 'tool_call' || e.type === 'edit_file' || e.type === 'file_stream') && e.pending === true && typeof e.title === 'string') {
      activity = clip(e.title.replace(/^[^\p{L}\p{N}]+/u, ''), 48);
      break;
    }
  }
  return { waiting, activity, lastLine, lastTs, outputs: outputsOf(entries).map(({ path, ext }) => ({ path, ext })) };
}
