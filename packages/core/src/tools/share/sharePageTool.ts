import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { unwrapApiKey } from '@neoxlabs/platform/utils/apiKeyCrypto.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { missingR2Fields, shareToR2, type R2ShareConfig } from './r2Share.js';

export function readR2ShareConfig(): R2ShareConfig | null {
  const r2 = (loadConfig() as any).share?.r2 as Partial<R2ShareConfig> | undefined;
  if (!r2 || missingR2Fields(r2).length) return null;
  return { ...(r2 as R2ShareConfig), secretAccessKey: unwrapApiKey(r2.secretAccessKey) };
}

export const sharePageTool: Tool = {
  name: 'share_page',
  description: 'Publish a finished web page (an .html file) or a folder (index.html plus its assets) to the user\'s own '
    + 'Cloudflare R2 bucket and get a public link to send to others. Use it when the user wants to share or send what '
    + 'you built. Anyone with the link can open it — only share what the user asked to share. '
    + 'If it is not set up yet, the result says so; tell the user to fill Settings → Web sharing (or ~/.neox/config.json share.r2).',
  group: 'execute',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  /* 往公网发东西 —— 跟发消息同级, 非完全放开档要审批 */
  sideEffect: 'outbound',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The .html file or the folder to publish (absolute or relative to the workspace).' },
      entry: { type: 'string', description: 'Folder only: which file the link should open (default index.html, else the first .html).' },
    },
    required: ['path'],
  },
  function: async (args: any) => {
    const cfg = readR2ShareConfig();
    if (!cfg) {
      const r2 = (loadConfig() as any).share?.r2;
      const missing = missingR2Fields(r2);
      return JSON.stringify({
        ok: false,
        error: 'Web sharing is not set up.',
        missing,
        guidance: 'Ask the user to open Settings → Web sharing and fill in their Cloudflare R2 bucket (account ID, bucket, '
          + 'S3 access key ID and secret, public URL). It takes about two minutes; the page has the steps.',
      });
    }
    const raw = String(args?.path ?? '').trim();
    if (!raw) return JSON.stringify({ ok: false, error: 'path is required' });
    const target = isAbsolute(raw) ? raw : resolve(getWorkspaceRootFromContext() ?? process.cwd(), raw);
    if (!existsSync(target)) return JSON.stringify({ ok: false, error: `not found: ${target}` });
    try {
      const r = await shareToR2(cfg, target, typeof args?.entry === 'string' ? args.entry : undefined);
      return JSON.stringify({ ok: true, url: r.url, files: r.files, bytes: r.bytes,
        note: 'Public link — anyone with it can open the page. Give the user the URL.' });
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: String(err?.message ?? err).slice(0, 300) });
    }
  },
};
