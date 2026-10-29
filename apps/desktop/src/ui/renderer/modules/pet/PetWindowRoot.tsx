/**
 * PetWindowRoot — 桌宠核心窗口 React 根 (pet.html)
 *
 * 只负责"零运行时"的内置渲染: 灵动(svg) + 角色(sprite) + 兼容保留的 2d.
 * **不含 Three.js** — 3D 是独立插件页面 pet3d.html (Pet3DWindowRoot), 由主进程按需加载,
 * three 只进那个独立 bundle, 核心 pet 窗口包体保持轻量.
 *
 * 窗口外壳行为 (拖拽/心情/气泡/plan/打字) 全在 usePetWindowController + PetWindowFrame,
 * 跟 Pet3DWindowRoot 共用.
 */

import { useI18n } from '../../hooks/useI18n';
import React from 'react';
import type { PetMood } from './PetSceneR3F';
import Pet2DSprite from './Pet2DSprite';
import type { Pet2DSpec, Pet2DMood } from './pet2d';
import { PetSpriteSheet } from './PetSpriteSheet';
import { resolveSprite } from './spriteCandidates';
import { moodToSpriteState } from './petSpriteStates';
import NeoxPetSvg from './svg/NeoxPetSvg';
import { usePetWindowController } from './usePetWindowController';
import { PetWindowFrame, PetCenter } from './PetWindowFrame';

/* PetMood → Pet2DMood 映射 (2d 兼容模式用) */
function moodTo2D(mood: PetMood): Pet2DMood {
  switch (mood) {
    case 'happy':
    case 'success': return 'happy';
    case 'sleeping': return 'sleeping';
    case 'error': return 'error';
    case 'speaking': return 'speaking';
    case 'thinking':
    case 'waiting': return 'thinking';
    default: return 'idle';
  }
}

const HINT_STYLE: React.CSSProperties = {
  color: 'rgba(255,255,255,0.6)', fontSize: 11,
  background: 'rgba(20,20,24,0.8)', padding: '6px 10px', borderRadius: 6,
  pointerEvents: 'none', textAlign: 'center',
};

const PetWindowRoot: React.FC = () => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const controller = usePetWindowController();
  const { config, mood, typing, size } = controller;

  if (!config) return null;

  const pet2DSpec = config.mode === '2d' ? (config.active2DSpec as Pet2DSpec | null) : null;
  const spriteResolved = config.mode === 'sprite'
    ? resolveSprite(config.activeSpriteId ?? null, config.customSprites)
    : null;

  return (
    <PetWindowFrame controller={controller}>
      {config.mode === 'svg' && (
        <PetCenter>
          <NeoxPetSvg mood={mood} size={size} variant={config.svgVariant} typing={typing} />
        </PetCenter>
      )}

      {config.mode === 'sprite' && spriteResolved && (
        <PetCenter>
          <PetSpriteSheet
            url={spriteResolved.url}
            state={typing && mood === 'idle' ? 'running' : moodToSpriteState(mood)}
            size={size * 0.95}
            atlas={
              spriteResolved.cellWidth && spriteResolved.cellHeight
                ? { cols: 8, rows: 9, cellWidth: spriteResolved.cellWidth, cellHeight: spriteResolved.cellHeight }
                : undefined
            }
            paused={mood === 'sleeping'}
          />
        </PetCenter>
      )}

      {config.mode === 'sprite' && !spriteResolved && (
        <PetCenter><div style={{ ...HINT_STYLE, maxWidth: size * 1.5 }}>{zh ? <>选个角色<br/>(设置里)</> : <>Pick a character<br/>(in Settings)</>}</div></PetCenter>
      )}

      {config.mode === '2d' && pet2DSpec && (
        <PetCenter><Pet2DSprite spec={pet2DSpec} mood={moodTo2D(mood)} size={size} /></PetCenter>
      )}

      {config.mode === '2d' && !pet2DSpec && (
        <PetCenter><div style={{ ...HINT_STYLE, maxWidth: size * 1.5 }}>{zh ? <>还没 roll 2D 桌宠<br/>设置里点 🎲</> : <>No 2D pet yet<br/>roll one in Settings 🎲</>}</div></PetCenter>
      )}
    </PetWindowFrame>
  );
};

export default PetWindowRoot;
