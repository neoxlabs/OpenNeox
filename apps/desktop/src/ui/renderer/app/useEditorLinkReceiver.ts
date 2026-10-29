import { useEffect, useRef } from 'react';
import type { EditorLinkRequest } from '../../shared/ipc';
import { sendCodeToComposer, intentPrompt, diagnosticPrompt } from '../modules/editor/editorAiBridge';
import { sameWorkspace } from '../utils/pathUtils';
import { dispatchHint } from '../components/notifyEvents';

interface Options {
  workspacePath: string | null | undefined;
  openProject: (path: string) => Promise<void>;
  closeSettings: () => void;
  zh: boolean;
}

export function useEditorLinkReceiver(opts: Options): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const api = window.neox;
    if (!api?.editorLinkDrain) return;

    const handle = async (req: EditorLinkRequest) => {
      const { workspacePath, openProject, closeSettings, zh } = optsRef.current;
      if (req.kind === 'open') {
        if (!sameWorkspace(req.folder, workspacePath)) await openProject(req.folder);
        return;
      }
      closeSettings();
      let switched = false;
      if (req.workspace && !sameWorkspace(req.workspace, workspacePath)) {
        await openProject(req.workspace);
        switched = true;
      }
      window.dispatchEvent(new CustomEvent('neox:show-chat'));
      const prompt = req.diag
        ? diagnosticPrompt({ message: req.diag.message, startLineNumber: req.diag.line, endLineNumber: req.diag.line }, zh)
        : req.intent ? intentPrompt(req.intent, zh) : undefined;
      const ok = await sendCodeToComposer(req.code, { prompt, send: !!prompt && !switched }, switched ? 8000 : 1500);
      if (!ok) {
        dispatchHint(zh ? '没找到对话输入框 —— 先打开一个会话再从编辑器发送' : 'No chat input found — open a chat, then send from your editor again', 'warning');
      }
    };

    let busy = false;
    let again = false;
    const drain = async () => {
      if (busy) { again = true; return; }
      busy = true;
      try {
        do {
          again = false;
          const reqs = await api.editorLinkDrain!();
          for (const r of reqs) await handle(r);
        } while (again);
      } catch (err) {
        console.warn('[editorLink] drain failed:', err);
      } finally {
        busy = false;
      }
    };

    const off = api.onEditorLinkPing?.(() => { void drain(); });
    void drain();
    return () => off?.();
  }, []);
}
