/**
 * Pet3DWindowRoot — 3D 桌宠插件页面的 React 根 (pet3d.html)
 *
 * 跟 PetWindowRoot 平级, 但只负责 3D 渲染. Three.js + r3f + drei 只在这个 bundle 里,
 * 主进程仅当用户启用"立体"插件 + 选 3D 模式时才加载 pet3d.html, 核心 pet 窗口完全不含 three.
 *
 * 窗口外壳 (拖拽/心情/气泡/plan/打字) 复用 usePetWindowController + PetWindowFrame.
 */

import React, { lazy, Suspense } from 'react';
import { resolveSkin } from './petCandidates';
import { PetErrorBoundary } from './PetErrorBoundary';
import { usePetWindowController } from './usePetWindowController';
import { PetWindowFrame } from './PetWindowFrame';

const LazyPetSceneR3F = lazy(() =>
  import('./PetSceneR3F').then((m) => ({ default: m.PetSceneR3F }))
);

const Pet3DWindowRoot: React.FC = () => {
  const controller = usePetWindowController();
  const { config, mood, size } = controller;

  if (!config) return null;

  const skinResolved = resolveSkin(config.skin, config.customSkins);

  return (
    <PetWindowFrame controller={controller}>
      <PetErrorBoundary
        fallback={
          <div style={{
            width: '100%', height: '100%', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontSize: size * 0.55, pointerEvents: 'none',
          }}>🤖</div>
        }
      >
        <Suspense
          fallback={
            <div style={{
              position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
              width: size * 0.6, height: size * 0.6, borderRadius: '50%',
              background: 'radial-gradient(circle at 35% 30%, rgba(255,255,255,0.3), rgba(0,0,0,0.1))',
              opacity: 0.5,
            }} />
          }
        >
          <LazyPetSceneR3F url={skinResolved.url} mood={mood} hueShift={skinResolved.hueShift} />
        </Suspense>
      </PetErrorBoundary>
    </PetWindowFrame>
  );
};

export default Pet3DWindowRoot;
