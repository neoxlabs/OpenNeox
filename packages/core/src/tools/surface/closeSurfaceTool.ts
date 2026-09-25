/**
 * close_surface — 关闭已打开的 surface (从右栏 tab 移除)
 *
 * 用户一般会自己关, agent 也可以在"产出物已经过期, 不再相关"时主动关.
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import {
  SURFACE_MARKER,
  type SurfaceMarkerPayload,
} from './surfaceTypes.js';

interface CloseSurfaceArgs {
  surface_id: string;
}

export const closeSurfaceTool: Tool = {
  name: 'close_surface',
  description: `Close a surface tab on the user's right panel. surface_id from open_surface.

Don't close surfaces the user is actively looking at — let them dismiss it themselves.
Useful when an artifact is clearly stale (e.g. you opened a draft, then merged into final, draft can go).`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,
  aliases: ['surface_close', 'closeSurface'],

  parameters: {
    type: 'object',
    properties: {
      surface_id: {
        type: 'string',
        description: 'The surface_id to close.',
      },
    },
    required: ['surface_id'],
  },

  async function(args: CloseSurfaceArgs): Promise<string> {
    if (!args?.surface_id) {
      return JSON.stringify({ error: 'surface_id is required' });
    }
    const payload: SurfaceMarkerPayload = {
      [SURFACE_MARKER]: true,
      action: 'close',
      surfaceId: args.surface_id,
    };
    return JSON.stringify(payload);
  },
};
