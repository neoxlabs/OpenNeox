/**
 * PetSceneR3F — 桌宠 3D 渲染器 (跑在 pet window 内)
 *
 * 设计:
 *   · 一个透明 Canvas (alpha:true), 占满 pet 窗口
 *   · 加载 /pets/<skin>.glb (vite publicDir 本地 host)
 *   · 按 mood prop 选择对应 animation clip 播
 *   · SkeletonUtils.clone(scene) 避免多桌宠实例 (or 配色变体) 共享材质打架
 *   · OrbitControls **不** 开 — 桌宠整体走 window-drag (electron 层) 不在 DOM 拖
 *
 * 性能:
 *   · dpr capped at [1, 1.5] — 不跑全 retina, GPU 省一半
 *   · frameloop="always" (默认), 真正 idle 时由 useAnimations 控制 (clip pause)
 *   · 不开 shadows (桌宠太小, 用户视觉上看不出)
 *   · gl.premultipliedAlpha:true + alpha:true → 透明背景跟桌面合成正确
 *   · React.lazy 在 PetWindowRoot 那侧加, 这里不直接 import — 让 T63 阶段
 *     bundle 不带 Three.js
 *
 * mood → clip 映射 (用 RobotExpressive 自带 14 套, 其它 .glb 各 skin 自定义).
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, useAnimations } from '@react-three/drei';
import { SkeletonUtils } from 'three-stdlib';
import * as THREE from 'three';

/* 预加载 — Canvas 还没 mount 就开始拉 .glb, 让首帧出现时模型已经在 cache 里.
 * 避免首帧同步阻塞 90ms (loadGLTF + parseScene + setupAnimations) 触发 macOS GPU watchdog. */
useGLTF.preload(`${import.meta.env.BASE_URL}pets/robot.glb`);

export type PetMood =
  | 'idle'
  | 'coding'
  | 'reading'
  | 'thinking'
  | 'running'
  | 'happy'
  | 'success'
  | 'error'
  | 'waiting'
  | 'speaking'
  | 'sleeping';

/** 默认 mood→clip 映射 (RobotExpressive 模型). 别的 skin 通过 props 覆盖. */
const DEFAULT_MOOD_CLIPS: Record<PetMood, string> = {
  idle: 'Idle',
  coding: 'Sitting',
  reading: 'Sitting',
  thinking: 'Standing',
  running: 'Walking',
  happy: 'ThumbsUp',
  success: 'Dance',
  error: 'No',
  waiting: 'Wave',
  speaking: 'Yes',
  sleeping: 'Death',
};

interface PetModelProps {
  url: string;
  mood: PetMood;
  hueShift: number;
  /** 自定义 mood→clip 映射 (按 skin 不同; 缺省走 RobotExpressive 那一套) */
  moodClips?: Partial<Record<PetMood, string>>;
}

const PetModel: React.FC<PetModelProps> = ({ url, mood, hueShift, moodClips }) => {
  /* 诊断: useGLTF 内部 Suspense 抛 thenable, 网络/解析失败会成 unhandled rejection.
   * 这里手动 fetch 一次 HEAD 探测, 失败时主动 throw 把错误抛给 PetErrorBoundary,
   * 不让用户看到永久的"空白" Suspense fallback. */
  React.useEffect(() => {
    fetch(url, { method: 'HEAD' }).then((r) => {
      if (!r.ok) {
        console.error(`[PetSceneR3F] HEAD ${url} failed: ${r.status} ${r.statusText}`);
      } else {
        console.log(`[PetSceneR3F] HEAD ${url} ok, content-type: ${r.headers.get('content-type')}`);
      }
    }).catch((err) => {
      console.error(`[PetSceneR3F] HEAD ${url} threw:`, err);
    });
  }, [url]);

  const { scene: rawScene, animations } = useGLTF(url);
  const groupRef = useRef<THREE.Group>(null);

  /* 诊断: scene 加载成功的话 log 出 mesh 数量 + 动画 clip 名, 方便确认 .glb 真解析了 */
  React.useEffect(() => {
    let meshCount = 0;
    rawScene.traverse((obj) => { if ((obj as THREE.Mesh).isMesh) meshCount++; });
    console.log(`[PetModel] scene loaded for ${url}: ${meshCount} meshes, ${animations.length} animations [${animations.map((a) => a.name).join(', ')}]`);
  }, [rawScene, animations, url]);

  /* 每个实例独立 scene + 独立 material clones — 同 .glb 多变体 (色相不同) 并存不互踩.
   * useMemo 锁定 url, url 变 (用户切 skin) 自动重做. */
  const scene = useMemo(() => {
    const cloned = SkeletonUtils.clone(rawScene);
    cloned.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const clonedMats = mats.map((m) => (m as THREE.Material).clone());
        mesh.material = clonedMats.length === 1 ? clonedMats[0] : (clonedMats as any);
      }
    });
    return cloned;
  }, [rawScene]);

  /* 色相旋转 — 推迟到下一个 idle tick, 让首帧只渲染原色 mesh, 不阻塞 GPU.
   * macOS GPU watchdog 看到首帧 90ms 会把 WebGL context 杀掉; 把这步从首帧拆出去
   * 给 watchdog 留窗口. requestIdleCallback 不在所有浏览器有, fallback 用 setTimeout. */
  useEffect(() => {
    if (!hueShift) return;
    const apply = () => {
      const hsl = { h: 0, s: 0, l: 0 };
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((m) => {
            const c = (m as any).color as THREE.Color | undefined;
            if (!c) return;
            c.getHSL(hsl);
            c.setHSL((hsl.h + hueShift) % 1, hsl.s, hsl.l);
          });
        }
      });
    };
    const ric = (window as any).requestIdleCallback as undefined | ((cb: () => void, opts?: any) => number);
    const handle = ric ? ric(apply, { timeout: 500 }) : window.setTimeout(apply, 100);
    return () => {
      const cic = (window as any).cancelIdleCallback as undefined | ((h: number) => void);
      if (ric && cic) cic(handle); else window.clearTimeout(handle);
    };
  }, [scene, hueShift]);

  const { actions, names } = useAnimations(animations, groupRef);

  /* mood 变化 → 切 clip. fade in/out 让动画过渡丝滑, 不是硬切. */
  useEffect(() => {
    if (names.length === 0) return;
    const merged = { ...DEFAULT_MOOD_CLIPS, ...(moodClips ?? {}) };
    const clipName = merged[mood];
    /* 落到该 clip; 找不到就回 idle, idle 也没有就播第一个 */
    const fallback = merged.idle ?? names[0];
    const chosen = (clipName && actions[clipName]) ? clipName
                 : (actions[fallback] ? fallback : names[0]);
    const action = actions[chosen];
    if (!action) return;
    action.reset().fadeIn(0.3).play();
    return () => {
      action.fadeOut(0.3);
    };
  }, [actions, names, mood, moodClips]);

  /* 缓慢自旋, 让 idle 不死板. 角速度根据 mood 调 — sleeping 时停转, dance 时稍快. */
  useFrame((_, dt) => {
    if (!groupRef.current) return;
    let speed = 0.3;
    if (mood === 'sleeping') speed = 0;
    else if (mood === 'success' || mood === 'happy') speed = 0.8;
    groupRef.current.rotation.y += dt * speed;
  });

  useEffect(() => {
    scene.scale.setScalar(1);
    scene.position.set(0, 0, 0);
    scene.updateMatrixWorld(true); /* 强制刷新, 否则 Box3 拿到老的 cached matrix */
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    /* scale: 让 model 高度填满 ~1.5 单位 (camera z=3 fov 40 视野约 2.2 单位高, 留 30% 边距) */
    const targetHeight = 1.5;
    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    /* 同时对宽 / 高 / 深取最大值算 scale, 防 .glb 横向超长的模型 (e.g. dragon) 被 y 主导
     * 缩放后宽度溢出视口 → 看到的是 "切了一刀" 而非"小". */
    const scale = targetHeight / maxDim;
    scene.scale.setScalar(scale);
    scene.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
  }, [scene]);

  return (
    <group ref={groupRef}>
      <primitive object={scene} />
    </group>
  );
};

export interface PetSceneR3FProps {
  url: string;
  mood: PetMood;
  hueShift?: number;
  moodClips?: Partial<Record<PetMood, string>>;
}

/* WebGL 创建失败 / .glb 加载失败时的 emoji fallback — 让用户知道桌宠出问题了,
 * 而不是完全空白. */
const PetFallback: React.FC = () => (
  <div
    style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 64,
      pointerEvents: 'none',
      userSelect: 'none',
    }}
  >
    🤖
  </div>
);

/** 全屏透明 Canvas. 父容器需 pointer-events:none, sprite 本身 pointer-events:auto. */
export const PetSceneR3F: React.FC<PetSceneR3FProps> = ({ url, mood, hueShift = 0, moodClips }) => {
  /* WebGL 不可用兜底 — onCreated 超过 5s 没触发, 切到 emoji fallback */
  const [glFailed, setGlFailed] = React.useState(false);
  const glOkRef = React.useRef(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      if (!glOkRef.current) {
        console.error('[PetSceneR3F] WebGL Canvas did not initialize within 5s — using emoji fallback');
        setGlFailed(true);
      }
    }, 5000);
    return () => window.clearTimeout(t);
  }, []);

  if (glFailed) return <PetFallback />;

  return (
    <Canvas
      camera={{ position: [0, 0, 3], fov: 40 }}
      gl={{
        /* macOS + Electron 透明窗口 + WebGL 的 "Context Lost" 解药:
         *   - antialias:false   — multisample buffer 会跟透明合成抢, 关
         *   - premultipliedAlpha:false — 跟透明窗口合成兼容性更好
         *   - preserveDrawingBuffer:true — context 丢失后能 restore, 不重建 GL state
         *   - powerPreference:'default' — 不强制 'low-power' (会触发软件回退路径, 反而不稳)
         *   - failIfMajorPerformanceCaveat:false — 允许软件 fallback, 避免在透明合成路径上直接 fail
         *   - stencil:false / depth:true — 关掉 stencil buffer, 用最朴素的 framebuffer
         */
        alpha: true,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        powerPreference: 'default',
        failIfMajorPerformanceCaveat: false,
        stencil: false,
        depth: true,
      }}
      dpr={[1, 1.5]}
      shadows={false}
      onCreated={({ gl }) => {
        glOkRef.current = true;
        console.log(`[PetSceneR3F] Canvas created, maxTextureSize=${gl.capabilities?.maxTextureSize ?? 'unknown'}, url=${url}`);
        /* context lost / restored 监听 — macOS 透明合成器经常回收 context, 三声做 restore 但 mesh
         * 引用要重新提交. 监听一下看症状是 lost-未恢复 还是 lost-反复振荡. */
        const canvas = gl.domElement;
        canvas.addEventListener('webglcontextlost', (e) => {
          console.warn('[PetSceneR3F] webglcontextlost', e);
          (e as Event).preventDefault(); // 告诉浏览器我们想要 restore
        });
        canvas.addEventListener('webglcontextrestored', () => {
          console.log('[PetSceneR3F] webglcontextrestored — Three.js 自动重建场景');
        });
      }}
      style={{ width: '100%', height: '100%', background: 'transparent' }}
    >
      {/* 灯光 — 顶+前+背三盏, 给 3D 模型基本立体感 (无 shadow, 极轻量) */}
      <ambientLight intensity={0.7} />
      <directionalLight position={[2, 4, 3]} intensity={1.3} />
      <directionalLight position={[-2, 1, -3]} intensity={0.4} />
      <React.Suspense fallback={null}>
        <PetModel url={url} mood={mood} hueShift={hueShift} moodClips={moodClips} />
      </React.Suspense>
    </Canvas>
  );
};

export { PetFallback };
