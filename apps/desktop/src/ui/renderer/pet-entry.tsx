/**
 * pet-entry.tsx — 桌宠独立窗口的 React 入口
 *
 * 跟 main.tsx 平行的第二入口 (vite rollupOptions.input.pet → pet.html → pet-entry.tsx).
 * 不引入 Neox 主 app — 不要 NeoxRuntimeBridge / NeoxShellHost / Settings / 路由 / auth...
 * 只渲染 PetWindowRoot, 把整个 bundle 控制在 < 200KB (含 React).
 *
 * Three.js + drei + r3f 在 PetSceneR3F 里通过 React.lazy 按需加载, 不进首屏 chunk.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import PetWindowRoot from './modules/pet/PetWindowRoot';

const container = document.getElementById('pet-root');
if (!container) {
  throw new Error('[pet-entry] #pet-root not found in pet.html');
}

const root = createRoot(container);
root.render(<PetWindowRoot />);
