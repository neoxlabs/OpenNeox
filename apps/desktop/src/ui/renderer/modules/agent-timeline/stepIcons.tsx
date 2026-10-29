import React from 'react';
import {
  IconLayers,
  IconFile,
  IconTerminal,
  IconWeb,
  IconSpark,
  IconZap,
  IconCode,
  IconCheck,
  IconClock,
  IconSearch,
  IconDatabase,
  IconRefresh,
  IconPencil,
  IconDisplay,
  IconBook,
  IconFolder,
  IconBulb,
  IconCube,
  IconPlugin,
} from '../shell/shellIcons';
import type { StepIconKind } from './types';

/* 把 StepIconKind 映射到 SVG 组件 + tint class (.atl-tool__icon--x) */
export function getStepIconInfo(kind: StepIconKind): {
  Icon: React.ComponentType<{ size?: number }>;
  className: string;
} {
  switch (kind) {
    case 'thinking': return { Icon: IconBulb,     className: 'atl-tool__icon--thinking' };
    case 'task':     return { Icon: IconLayers,   className: 'atl-tool__icon--task' };
    case 'project':  return { Icon: IconCube,     className: 'atl-tool__icon--project' };
    case 'file':     return { Icon: IconFile,     className: 'atl-tool__icon--file' };
    case 'read':     return { Icon: IconBook,     className: 'atl-tool__icon--file' };
    case 'folder':   return { Icon: IconFolder,   className: 'atl-tool__icon--file' };
    case 'terminal': return { Icon: IconTerminal, className: 'atl-tool__icon--terminal' };
    case 'web':      return { Icon: IconWeb,      className: 'atl-tool__icon--web' };
    case 'generate': return { Icon: IconSpark,    className: 'atl-tool__icon--generate' };
    case 'edit':     return { Icon: IconCode,     className: 'atl-tool__icon--edit' };
    case 'test':     return { Icon: IconCheck,    className: 'atl-tool__icon--test' };
    case 'summary':  return { Icon: IconClock,    className: 'atl-tool__icon--summary' };
    case 'diff':     return { Icon: IconPencil,   className: 'atl-tool__icon--diff' };
    case 'search':   return { Icon: IconSearch,   className: 'atl-tool__icon--search' };
    case 'database': return { Icon: IconDatabase, className: 'atl-tool__icon--database' };
    case 'retry':    return { Icon: IconRefresh,  className: 'atl-tool__icon--retry' };
    case 'skill':    return { Icon: IconZap,      className: 'atl-tool__icon--skill' };
    case 'computer': return { Icon: IconDisplay,  className: 'atl-tool__icon--computer' };
    case 'plugin':   return { Icon: IconPlugin,   className: 'atl-tool__icon--task' };
    default:         return { Icon: IconLayers,   className: 'atl-tool__icon--task' };
  }
}
