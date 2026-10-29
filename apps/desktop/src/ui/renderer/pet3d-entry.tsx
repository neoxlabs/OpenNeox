/**
 * pet3d-entry.tsx — 3D 桌宠插件页面入口 (vite input.pet3d → pet3d.html)
 *
 * 跟 pet-entry.tsx 平级的独立入口. Three.js + r3f + drei 全部进这个 bundle,
 * 跟核心 pet bundle 完全隔离 — 主进程只在 3D 模式时加载 pet3d.html.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import Pet3DWindowRoot from './modules/pet/Pet3DWindowRoot';

const container = document.getElementById('pet-root');
if (!container) {
  throw new Error('[pet3d-entry] #pet-root not found in pet3d.html');
}

const root = createRoot(container);
root.render(<Pet3DWindowRoot />);
