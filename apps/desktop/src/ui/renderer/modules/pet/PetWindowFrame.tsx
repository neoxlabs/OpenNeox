/**
 * PetWindowFrame — 桌宠窗口的"外壳"(透明全屏容器 + 交互层 + 气泡 + plan)
 *
 * 渲染无关的窗口外壳, 中间放什么由 children 决定 (svg/sprite 或 3D).
 * 配合 usePetWindowController 使用 — controller 给行为, frame 给容器/气泡/plan.
 */

import React from 'react';
import { useI18n } from '../../hooks/useI18n';
import PetBubble from './PetBubble';
import PetPlanBar from './PetPlanBar';
import type { PetWindowController } from './usePetWindowController';

export interface PetWindowFrameProps {
  controller: PetWindowController;
  children: React.ReactNode;
}

export const PetWindowFrame: React.FC<PetWindowFrameProps> = ({ controller, children }) => {
  const { isZh } = useI18n();
  const { config, bubble, plan, handlers, draggingRef } = controller;
  if (!config) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }}>
      <div
        onPointerDown={handlers.onPointerDown}
        onPointerMove={handlers.onPointerMove}
        onPointerUp={handlers.onPointerUp}
        onContextMenu={handlers.onContextMenu}
        onClick={handlers.onClick}
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'auto',
          cursor: draggingRef.current ? 'grabbing' : 'grab',
          touchAction: 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
        title={isZh ? '拖我到桌面任何角落 (右键关闭, 单击摸头)' : 'Drag me anywhere (right-click to dismiss, click to pet)'}
      >
        {children}

        {config.speechBubble && (
          <PetBubble text={bubble?.text ?? null} kind={bubble?.kind ?? 'speech'} />
        )}
        {config.showPlanProgress && plan && (
          <PetPlanBar done={plan.done} total={plan.total} />
        )}
      </div>
    </div>
  );
};

/** 居中放置渲染物的小工具 (svg/sprite/3D 都居中) */
export const PetCenter: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', pointerEvents: 'none' }}>
    {children}
  </div>
);

export default PetWindowFrame;
