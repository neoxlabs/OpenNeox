/**
 * usePetWindowSync — 把 petConfig (主窗口 localStorage store) 跟 pet 独立窗口
 * 的生命周期 / 配置同步起来. 在 AppShell 顶层挂一次就行.
 *
 * 行为:
 *   · cfg.enabled true→false: 让主进程 destroyPetWindow()
 *   · cfg.enabled false→true: 让主进程 spawnPetWindow(cfg)
 *   · cfg 其它字段变化 (skin/size/corner/...): updateConfig 推到 pet window
 *   · pet 窗口里用户右键 dismiss: 反向同步 petConfig.enabled = false (PetTab toggle 自动跟新)
 *
 * 性能:
 *   · usePetConfig subscribe 只在 cfg 真改变时 re-run 副作用
 *   · spawn / destroy / updateConfig 都是 fire-and-forget, 不阻塞主线程
 *   · pet 窗口启动的 ~100ms cold start 都在独立 renderer process 里, 跟主窗口完全解耦
 */

import { useEffect, useRef } from 'react';
import { petConfig, usePetConfig } from './petConfig';
import { dispatchOpFailed } from '../../components/notifyEvents';

interface PetWindowApi {
  spawn: (cfg: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; windowId?: number }>;
  destroy: () => Promise<{ ok: boolean }>;
  updateConfig: (cfg: Record<string, unknown>) => Promise<{ ok: boolean }>;
  forwardAgentEvent: (evt: unknown) => Promise<{ ok: boolean }>;
  onDismissedByUser: (handler: () => void) => () => void;
}

function petApi(): PetWindowApi | null {
  const neox = (window as unknown as { neox?: { pet?: PetWindowApi } }).neox;
  return neox?.pet ?? null;
}

/** 判断当前 mode 是否需要 vibrancy 窗口 (3d) 还是真透明窗口 (2d/sprite).
 * mode 跨这条边界时, 必须 destroy + spawn 重建窗口, 因为 transparent/vibrancy 是
 * BrowserWindow 构造期固定的, 不能在运行时改. */
function needsVibrancyWindow(mode: 'svg' | '3d' | '2d' | 'sprite'): boolean {
  return mode === '3d';
}

export function usePetWindowSync(): void {
  const cfg = usePetConfig();
  const lastEnabledRef = useRef<boolean | null>(null);
  const lastVibrancyRef = useRef<boolean | null>(null);

  /* 同步 enabled → spawn/destroy 边沿 + mode 变更 → respawn (跨 vibrancy/transparent 边界) */
  useEffect(() => {
    const api = petApi();
    if (!api) return; /* preload 还没接通 (开发期 hot reload 可能短暂这样), 下一次 cfg 变更会重试 */
    const wasEnabled = lastEnabledRef.current;
    const isEnabled = cfg.enabled;
    const currentVibrancy = needsVibrancyWindow(cfg.mode);
    const lastVibrancy = lastVibrancyRef.current;

    /* 边沿检测: 1) enabled 状态变了, 或 2) enabled 中但 vibrancy regime 切换了 */
    const needsRespawn = isEnabled && wasEnabled === true && lastVibrancy !== null && lastVibrancy !== currentVibrancy;
    const needsToggle = wasEnabled !== isEnabled;
    if (!needsRespawn && !needsToggle) return;

    lastEnabledRef.current = isEnabled;
    if (isEnabled) lastVibrancyRef.current = currentVibrancy;

    /* respawn 路径: 先 destroy 老窗口, 再 spawn 新的 */
    const doSpawn = (): void => {
      const active2DSpec = cfg.mode === '2d'
        ? cfg.savedPet2Ds.find((s) => s.id === cfg.active2DId) ?? null
        : null;
      api.spawn({
        mode: cfg.mode,
        svgVariant: cfg.svgVariant,
        skin: cfg.skin,
        size: cfg.size,
        corner: cfg.corner,
        speechBubble: cfg.speechBubble,
        showPlanProgress: cfg.showPlanProgress,
        reactOnTaskComplete: cfg.reactOnTaskComplete,
        reactOnError: cfg.reactOnError,
        idleAnimations: cfg.idleAnimations,
        customSkins: cfg.customSkins,
        active2DSpec,
        activeSpriteId: cfg.activeSpriteId,
        customSprites: cfg.customSprites,
      }).then((res) => {
        if (!res.ok) {
          console.error('[usePetWindowSync] spawn returned !ok:', res.error);
          dispatchOpFailed({ op: 'pet-spawn', message: '桌宠开启失败: ' + (res.error ?? '未知错误') });
          petConfig.set('enabled', false);
        }
      }).catch((err) => {
        console.error('[usePetWindowSync] spawn IPC threw:', err);
        dispatchOpFailed({ op: 'pet-spawn', message: '桌宠开启失败: ' + (err?.message ?? String(err)) });
        petConfig.set('enabled', false);
      });
    };

    if (needsRespawn) {
      /* 模式切换跨 transparent 边界 — destroy 后立刻 spawn */
      api.destroy().then(() => doSpawn()).catch((err) => {
        console.error('[usePetWindowSync] respawn destroy failed:', err);
        doSpawn(); /* destroy 失败也尝试 spawn */
      });
    } else if (isEnabled) {
      doSpawn();
    } else if (wasEnabled === true) {
      api.destroy().catch((err) => {
        console.error('[usePetWindowSync] destroy failed:', err);
      });
      lastVibrancyRef.current = null; /* 关掉后重置, 下次开启重新决定 */
    }
  }, [cfg.enabled, cfg.mode, cfg.svgVariant, cfg.skin, cfg.size, cfg.corner, cfg.speechBubble, cfg.showPlanProgress, cfg.reactOnTaskComplete, cfg.reactOnError, cfg.idleAnimations, cfg.customSkins, cfg.active2DId, cfg.savedPet2Ds, cfg.activeSpriteId, cfg.customSprites]);

  /* 字段变更 (skin/size/...) → updateConfig 推过去, 仅当当前 enabled */
  useEffect(() => {
    const api = petApi();
    if (!api || !cfg.enabled) return;
    const active2DSpec = cfg.mode === '2d'
      ? cfg.savedPet2Ds.find((s) => s.id === cfg.active2DId) ?? null
      : null;
    api.updateConfig({
      mode: cfg.mode,
      svgVariant: cfg.svgVariant,
      skin: cfg.skin,
      size: cfg.size,
      corner: cfg.corner,
      speechBubble: cfg.speechBubble,
      showPlanProgress: cfg.showPlanProgress,
      reactOnTaskComplete: cfg.reactOnTaskComplete,
      reactOnError: cfg.reactOnError,
      idleAnimations: cfg.idleAnimations,
      customSkins: cfg.customSkins,
      active2DSpec,
      activeSpriteId: cfg.activeSpriteId,
      customSprites: cfg.customSprites,
    }).catch((err) => {
      console.error('[usePetWindowSync] updateConfig failed:', err);
    });
  }, [cfg.enabled, cfg.mode, cfg.svgVariant, cfg.skin, cfg.size, cfg.corner, cfg.speechBubble, cfg.showPlanProgress, cfg.reactOnTaskComplete, cfg.reactOnError, cfg.idleAnimations, cfg.customSkins, cfg.active2DId, cfg.savedPet2Ds, cfg.activeSpriteId, cfg.customSprites]);

  /* pet 窗口里用户右键 dismiss → 把 enabled 切回 false, PetTab toggle 自动跟新 */
  useEffect(() => {
    const api = petApi();
    if (!api) return;
    return api.onDismissedByUser(() => {
      petConfig.set('enabled', false);
    });
  }, []);
}
