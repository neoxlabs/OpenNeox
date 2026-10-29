/**
 * PetPreview3D — Settings 里 "桌宠候选" 3D 预览
 *
 * 用 @react-three/fiber + @react-three/drei 加载 .glb, 自动播第一个动画 clip,
 * 配 OrbitControls 让用户拖着角度看 / 缩放. 模型自动 Bounds 居中 + 适配 viewport,
 * 不用为每个候选手调 camera.
 *
 * 当前用 threejs.org 的 demo .glb URL — 上线前应把内置 3 只换成自己托管的
 * CC0 资源 (poly.pizza / quaternius). 见 PET_CANDIDATES 注释里的 license.
 *
 * 性能: 整个 Canvas 在 Pet tab lazy chunk 里, 不打开设置完全不加载 three.js.
 * 用户不开桌宠这条路径下也不会触发.
 */

import React, { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, useAnimations, OrbitControls, Center } from '@react-three/drei';
import { SkeletonUtils } from 'three-stdlib';
import * as THREE from 'three';

/* 预加载 — 跟 PetSceneR3F 同款, 模块级 preload 让 Settings 打开预览时模型已在 cache.
 * 首帧避免同步 loadGLTF, 不触发 macOS GPU watchdog. */
useGLTF.preload(`${import.meta.env.BASE_URL}pets/robot.glb`);

interface PetModelProps {
  url: string;
  /** 指定播某个动画 clip 名; 不传则播第一个 */
  clipName?: string;
  /** 自动绕 Y 轴慢转 (showcase 用) */
  autoRotate?: boolean;
  /** HSL 色相旋转 (0-1, 0=不变 0.33=橙→绿 0.66=橙→蓝紫). 用于从单个 .glb 派生多个 "配色变体". */
  hueShift?: number;
}

const PetModel: React.FC<PetModelProps> = ({ url, clipName, autoRotate = true, hueShift = 0 }) => {
  const { scene: rawScene, animations } = useGLTF(url);
  const groupRef = useRef<THREE.Group>(null);

  /* 诊断 — 跟 PetSceneR3F 同款, 出问题时方便定位. 只在 dev 输出 (生产不刷 console 也省一次 traverse). */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let meshCount = 0;
    rawScene.traverse((obj) => { if ((obj as THREE.Mesh).isMesh) meshCount++; });
    console.log(`[PetPreview3D] scene loaded for ${url}: ${meshCount} meshes, ${animations.length} animations`);
  }, [rawScene, animations, url]);

  /* useGLTF 返回的是 cached scene — 直接 mutate 材质会污染同一 url 的其它实例.
   * SkeletonUtils.clone 深拷一份 (含骨骼引用), 再克隆每个材质. 这样几个色相变体并存
   * 互不打架, 也不会因为缓存复用看着像同一只. */
  const scene = useMemo(() => {
    const cloned = SkeletonUtils.clone(rawScene);
    cloned.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mesh.material = mats.map((m) => (m as THREE.Material).clone()) as any;
        if (!Array.isArray(mesh.material) && Array.isArray(mats) && mats.length === 1) {
          mesh.material = (mesh.material as any)[0];
        }
      }
    });
    return cloned;
  }, [rawScene]);

  /* 色相旋转 — 推迟到首帧之后, 跟 PetSceneR3F 同款理由 (避免首帧 90ms 触发 GPU watchdog) */
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

  useEffect(() => {
    if (names.length === 0) return;
    const name = clipName && actions[clipName] ? clipName : names[0];
    const action = actions[name];
    action?.reset().fadeIn(0.3).play();
    return () => {
      action?.fadeOut(0.3);
    };
  }, [actions, names, clipName]);

  useFrame((_, dt) => {
    if (autoRotate && groupRef.current) {
      groupRef.current.rotation.y += dt * 0.4;
    }
  });

  return (
    <group ref={groupRef}>
      <Center>
        <primitive object={scene} scale={1.4} />
      </Center>
    </group>
  );
};

interface PetPreview3DProps {
  url: string;
  clipName?: string;
  width?: number;
  height?: number;
  /** 用户能否拖动/缩放 (展示模式 false, 编辑模式 true) */
  interactive?: boolean;
  /** 色相旋转 (0-1), 传给 PetModel — 让单 .glb 派生出多种配色变体 */
  hueShift?: number;
}

export const PetPreview3D: React.FC<PetPreview3DProps> = ({
  url,
  clipName,
  width = 320,
  height = 280,
  interactive = true,
  hueShift = 0,
}) => {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 12,
        overflow: 'hidden',
        background: 'linear-gradient(180deg, var(--bg-elevated, #2a2a30) 0%, var(--bg-primary, #1a1a20) 100%)',
        position: 'relative',
      }}
    >
      <Canvas
        camera={{ position: [0, 1.0, 4.5], fov: 36 }}
        /* 跟 PetSceneR3F 同款 WebGL 配置 — 跨平台/虚拟机/远程桌面下更稳, 避免 Context Lost.
         * 主窗口不透明所以问题概率比 pet 窗口小, 但同款配置维护成本更低. */
        gl={{
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
        onCreated={({ gl }) => {
          if (import.meta.env.DEV) console.log(`[PetPreview3D] Canvas created, maxTextureSize=${gl.capabilities?.maxTextureSize ?? '?'}, url=${url}`);
        }}
      >
        <ambientLight intensity={0.6} />
        <directionalLight position={[3, 5, 3]} intensity={1.4} />
        <directionalLight position={[-3, 2, -3]} intensity={0.5} />
        <Suspense fallback={null}>
          {/* 删 Bounds — 跟 PetSceneR3F 同款理由 (首帧 30-40ms bbox 计算 → GPU watchdog).
           * 改用 Center + scale={1.4} + 适当 camera distance, 视觉一样 0 计算. */}
          <PetModel url={url} clipName={clipName} hueShift={hueShift} />
        </Suspense>
        {interactive && (
          <OrbitControls
            enablePan={false}
            enableZoom
            minDistance={1.5}
            maxDistance={8}
            target={[0, 0, 0]}
          />
        )}
      </Canvas>
    </div>
  );
};

/* PET_CANDIDATES + PetCandidate 已搬到 petCandidates.ts (纯数据, 不依赖 Three.js).
 * 这里只留 PetPreview3D 组件本体, 跟着 Three.js 一起被 PetTab lazy import. */
export { PET_CANDIDATES, type PetCandidate } from './petCandidates';
