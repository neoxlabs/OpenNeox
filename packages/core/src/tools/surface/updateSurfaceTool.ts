/**
 * update_surface — 更新已打开的 surface (换 source / 改 title / 钉/解钉)
 *
 * 典型场景: agent 把 mermaid 改了一版, 想让用户右侧看新版.
 *   update_surface({surface_id, patch: {source: {type:'inline', content: '...新 mermaid...'}}})
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import {
  SURFACE_MARKER,
  type Surface,
  type SurfaceMarkerPayload,
} from './surfaceTypes.js';

interface UpdateSurfaceArgs {
  surface_id: string;
  patch: Partial<Pick<Surface, 'source' | 'title' | 'pinned' | 'metadata' | 'kind'>>;
}

export const updateSurfaceTool: Tool = {
  name: 'update_surface',
  description: `Update an open surface — change source / title / pin / metadata.

Common: you produced a new version of the diagram and want the user's right panel to refresh.
\`update_surface({ surface_id: 'sfc-...', patch: { source: { type: 'inline', content: '<new mermaid>' } } })\`

If source.type='file', viewer auto-watches file changes — you usually don't need update_surface for file content,
just edit the file and the surface refreshes.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,
  aliases: ['surface_update', 'updateSurface'],

  parameters: {
    type: 'object',
    properties: {
      surface_id: {
        type: 'string',
        description: 'The surface_id returned by open_surface.',
      },
      patch: {
        type: 'object',
        description: 'Partial Surface fields to update. Common: source, title, pinned, metadata.',
      },
    },
    required: ['surface_id', 'patch'],
  },

  async function(args: UpdateSurfaceArgs): Promise<string> {
    if (!args?.surface_id) {
      return JSON.stringify({ error: 'surface_id is required' });
    }
    if (!args?.patch || typeof args.patch !== 'object') {
      return JSON.stringify({ error: 'patch is required (object)' });
    }
    const payload: SurfaceMarkerPayload = {
      [SURFACE_MARKER]: true,
      action: 'update',
      surfaceId: args.surface_id,
      patch: args.patch as Partial<Surface>,
    };
    return JSON.stringify(payload);
  },
};
