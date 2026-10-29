import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, OrbitControls, useAnimations, useGLTF } from '@react-three/drei';
import { SkeletonUtils } from 'three-stdlib';
import * as THREE from 'three';
import { useI18n } from '../../../hooks/useI18n';
import { useTimelineFeed } from '../../../state/timelineFeedStore';
import { getTtsOutputLevel, isTtsPlaying } from '../../../utils/ttsPlayer';
import { dropPilotPatrolNoise } from '../../agent-timeline/pilotPatrolFilter';
import type { PilotAvatarKind } from '../pilotStore';
import { useStageCards } from './StageCards';
import { StageHeadline } from './StageHeadline';
import { useNeoxRuntimeOptional } from '../../../app/NeoxRuntimeContext';
import './pilot-stage.css';

/** 每种形象的模型 —— 由 apps/desktop/scripts/pilot3d/build_pet.py 在 Blender 里生成
 *  要拼 BASE_URL: 生产包走 file://, 写死 '/pilot3d/..' 会解析到磁盘根 → 模型取不到, 整个应用崩成错误页 */
const MODEL_URLS: Record<PilotAvatarKind, string> = {
  cat: `${import.meta.env.BASE_URL}pilot3d/cat.glb`,
  corgi: `${import.meta.env.BASE_URL}pilot3d/corgi.glb`,
};

/** 模型下不来只丢角色, 不许冒到顶层把整个应用打成错误页 */
class CharacterBoundary extends React.Component<{ url: string; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.error(`[PilotStage] model ${this.props.url} failed:`, error); }
  render() { return this.state.failed ? null : this.props.children; }
}
/** 模型里的动作名 (build_pet.py 里定的) */
const CLIPS = { idle: 'Idle', greet: 'Wave' } as const;

export type StageMood = 'idle' | 'listening' | 'thinking' | 'working' | 'talking';

// ───────────────────────── 角色 ─────────────────────────

const tmpE = new THREE.Euler();
const tmpQ = new THREE.Quaternion();

const Character: React.FC<{ url: string; mood: StageMood }> = ({ url, mood }) => {
  const { scene: raw, animations } = useGLTF(url);
  const scene = useMemo(() => SkeletonUtils.clone(raw), [raw]);
  const root = useRef<THREE.Group>(null);
  const { actions } = useAnimations(animations, root);
  const pointer = useThree((s) => s.pointer);

  /* 统一大小: 不管模型多大, 站到地上、身高约 2 */
  const fit = useMemo(() => {
    /* 蒙皮网格量包围盒要用骨骼矩阵, 而它们在第一次渲染前还是空的 —— 先摆好骨头再量, 不然量出来大几百倍 */
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) { sm.skeleton.update(); sm.computeBoundingBox(); }
    });
    const box = new THREE.Box3().setFromObject(scene, true);
    const size = box.getSize(new THREE.Vector3());
    const scale = 2 / Math.max(size.y, 0.001);    return { scale, y: -box.min.y * scale, x: -((box.min.x + box.max.x) / 2) * scale, z: -((box.min.z + box.max.z) / 2) * scale };
  }, [scene]);

  /* 能动的部位: 头 (看你 / 点头 / 歪头), 下巴或嘴的形变 (说话) —— 找得到就动, 找不到就不动 */
  const rig = useMemo(() => {
    let head: THREE.Bone | null = null;
    let jaw: THREE.Bone | null = null;
    const mouth: Array<{ mesh: THREE.Mesh; index: number }> = [];
    const blink: Array<{ mesh: THREE.Mesh; index: number }> = [];
    /* 胸口的灯 (材质名 glow): 说话时跟着声音亮 */
    const glow: THREE.MeshStandardMaterial[] = [];
    scene.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (mat && mat.name === 'glow' && !glow.includes(mat)) glow.push(mat);
      if ((o as THREE.Bone).isBone) {
        if (!head && /^head|[_.]head/i.test(o.name)) head = o as THREE.Bone;
        if (!jaw && /jaw|mouth/i.test(o.name)) jaw = o as THREE.Bone;
      }
      const m = o as THREE.Mesh;
      if (m.isMesh && m.morphTargetDictionary) {
        for (const [name, index] of Object.entries(m.morphTargetDictionary)) {
          if (/mouth.?open|jaw.?open|^aa$|viseme_aa|mouth_a/i.test(name)) mouth.push({ mesh: m, index });
          if (/blink|eyes?.?clos/i.test(name)) blink.push({ mesh: m, index });
        }
      }
    });
    /* 头 / 下巴归舞台管: 每帧从静止姿势算起再叠偏移, 不然越叠越歪。
     * (导出器会把每根骨头都烘进每个动作, 不能拿"动作里有没有这根骨头"来判断谁在管它; build_pet.py 的动作不碰头) */
    const restOf = (b: THREE.Bone | null) => (b ? b.quaternion.clone() : null);
    return {
      head: head as THREE.Bone | null,
      jaw: jaw as THREE.Bone | null,
      headRest: restOf(head),
      jawRest: restOf(jaw),
      mouth,
      blink,
      glow,
    };
  }, [scene]);

  /* 开场挥个手, 然后一直待机 */
  useEffect(() => {
    const idle = actions[CLIPS.idle];
    const greet = actions[CLIPS.greet];
    if (greet && idle) {
      greet.reset().setLoop(THREE.LoopOnce, 1).fadeIn(0.2).play();
      greet.clampWhenFinished = true;
      const t = setTimeout(() => { greet.fadeOut(0.4); idle.reset().fadeIn(0.4).play(); }, 1800);
      return () => clearTimeout(t);
    }
    idle?.reset().play();
    return undefined;
  }, [actions]);

  const look = useRef({ x: 0, y: 0 });
  const mouthLv = useRef(0);
  const blinkAt = useRef(2);

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    const g = root.current;
    if (!g) return;
    g.scale.setScalar(fit.scale);
    const breath = mood === 'idle' ? 0.022 : mood === 'working' ? 0.01 : 0.014;
    g.scale.y = fit.scale * (1 + Math.sin(t * (mood === 'working' ? 3.2 : 1.6)) * breath);
    const bob = mood === 'working' ? Math.abs(Math.sin(t * 5.5)) * 0.045 : 0;
    g.position.y = fit.y + bob;
    const swayY = mood === 'idle' ? Math.sin(t * 0.45) * 0.22 : mood === 'thinking' ? Math.sin(t * 0.7) * 0.12 : 0;
    const swayZ = mood === 'working' ? Math.sin(t * 2.6) * 0.04 : mood === 'talking' ? Math.sin(t * 1.6) * 0.025 : mood === 'thinking' ? 0.05 : 0;
    g.rotation.y += (swayY - g.rotation.y) * Math.min(1, dt * 3);
    g.rotation.z += (swayZ - g.rotation.z) * Math.min(1, dt * 4);

    /* 说话的量: 有声音跟声音走, 只有字在出来时轻轻地张合 */
    const speaking = isTtsPlaying();
    const target = speaking ? Math.min(1, getTtsOutputLevel() * 1.6) : mood === 'talking' ? (Math.sin(t * 14) * 0.5 + 0.5) * 0.35 : 0;
    mouthLv.current += (target - mouthLv.current) * Math.min(1, dt * 18);

    /* 头: 看着你的鼠标; 想的时候歪头看上面; 说话时跟着嘴轻点 */
    /* 埋头干活时低头看着手上的活, 一点一点地点头; 其余时候看你的鼠标 */
    const want = mood === 'thinking'
      ? { x: -0.18, y: 0.25 }
      : mood === 'working'
        ? { x: 0.3 + Math.sin(t * 5.5) * 0.06, y: Math.sin(t * 0.9) * 0.18 }
        : { x: -pointer.y * 0.25, y: pointer.x * 0.45 };
    look.current.x += (want.x - look.current.x) * Math.min(1, dt * 4);
    look.current.y += (want.y - look.current.y) * Math.min(1, dt * 4);
    if (rig.head) {
      if (rig.headRest) rig.head.quaternion.copy(rig.headRest);
      tmpE.set(look.current.x + mouthLv.current * 0.08, look.current.y, mood === 'thinking' ? 0.15 : Math.sin(t * 0.8) * 0.02);
      rig.head.quaternion.multiply(tmpQ.setFromEuler(tmpE));
    }
    if (rig.jaw) {
      if (rig.jawRest) rig.jaw.quaternion.copy(rig.jawRest);
      tmpE.set(mouthLv.current * 0.35, 0, 0);
      rig.jaw.quaternion.multiply(tmpQ.setFromEuler(tmpE));
    }
    for (const { mesh, index } of rig.mouth) if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = mouthLv.current;
    /* 灯: 平时慢慢呼吸, 想的时候快一点, 说话时跟着嘴 */
    const idleGlow = mood === 'working' ? 1.2 + Math.sin(t * 9) * 0.8
      : mood === 'thinking' ? 0.9 + Math.sin(t * 5) * 0.5 : 0.8 + Math.sin(t * 1.7) * 0.25;
    for (const m of rig.glow) m.emissiveIntensity = idleGlow + mouthLv.current * 2.5;

    /* 眨眼: 每 2~5 秒一次 */
    if (rig.blink.length) {
      const phase = t - blinkAt.current;
      const v = phase > 0 && phase < 0.16 ? Math.sin((phase / 0.16) * Math.PI) : 0;
      for (const { mesh, index } of rig.blink) if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = v;
      if (phase > 0.16) blinkAt.current = t + 2 + Math.random() * 3;
    }
  });

  return (
    <group ref={root} position={[fit.x, fit.y, fit.z]}>
      <primitive object={scene} />
    </group>
  );
};

/* 下面一截被对白框 + 输入框盖着: 把画面整体往上挪, 角色站在露出来的那块中间 (转动中心不变) */
const BOTTOM_RESERVED_PX = 210;
const FrameAboveDialog: React.FC = () => {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const { width, height } = useThree((s) => s.size);
  useEffect(() => {
    camera.setViewOffset(width, height, 0, BOTTOM_RESERVED_PX / 2, width, height);
    camera.updateProjectionMatrix();
    return () => { camera.clearViewOffset(); };
  }, [camera, width, height]);
  return null;
};

/* 双击回正: 相机回到正面 */
const Controls: React.FC = () => {
  const ref = useRef<React.ElementRef<typeof OrbitControls>>(null);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const el = gl.domElement;
    /* 控件构造时 target 还是原点就存了"初始状态", 回正会对着脚底 —— target 生效后重新存一次 */
    ref.current?.saveState();
    const reset = () => ref.current?.reset();
    el.addEventListener('dblclick', reset);
    return () => el.removeEventListener('dblclick', reset);
  }, [gl]);
  return (
    <OrbitControls
      ref={ref}
      target={[0, 1.05, 0]}
      enablePan={false}
      enableDamping
      dampingFactor={0.08}
      minDistance={2.6}
      maxDistance={9}
      minPolarAngle={0.35}
      maxPolarAngle={1.62}
      rotateSpeed={0.7}
    />
  );
};

// ───────────────────────── 对白 ─────────────────────────

type FeedEntry = { type?: string; detail?: unknown; output?: unknown; text?: unknown; status?: string };
const textOf = (e: FeedEntry) => String(e.detail || e.output || e.text || '');
const clean = (s: string) => s
  .replace(/<neox-directive>[\s\S]*?<\/neox-directive>/g, '')
  .replace(/<\/?voice-turn>/g, '')
  .replace(/```[\s\S]*?```/g, '…')
  .replace(/[*#`>]/g, '')
  .trim();

/** Neox 自己插进会话的交接 (<cloud-shift …> / <night-shift-failed> / <phone-offline> …), 不是你交代的活 */
const INJECTED = /^\s*<[a-z][\w-]*[\s>]/i;

function useLastExchange(): { user: string; task: string; pilot: string; pilotAfterUser: boolean } {
  const feed = useTimelineFeed() as unknown as FeedEntry[];
  return useMemo(() => {
    const entries = dropPilotPatrolNoise(feed);
    let user = '';
    let task = '';
    let pilot = '';
    let pilotAfterUser = false;
    let seenUser = false;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!seenUser && !pilot && /^(assistant_message|agent_message|assistant_prefix)$/.test(e.type ?? '')) pilot = clean(textOf(e));
      if (e.type !== 'user_message') continue;
      const raw = textOf(e);
      if (!seenUser) {
        seenUser = true;
        user = INJECTED.test(raw) ? '' : clean(raw);
        pilotAfterUser = !!pilot;
      }
      /* 标题要的是你交代的那件活: 交接消息往前跳, 找到你说的那句 */
      if (!INJECTED.test(raw)) { task = raw; break; }
    }
    return { user, task, pilot, pilotAfterUser };
  }, [feed]);
}

// ───────────────────────── 舞台 ─────────────────────────

export interface PilotStageProps {
  sessionId?: string | null;
  look: PilotAvatarKind;
  name: string;
  /** 它这一轮还在跑 */
  streaming: boolean;
  /** 点对白框 = 展开完整记录 */
  onOpenTranscript: () => void;
}

const PilotStage: React.FC<PilotStageProps> = ({ sessionId, look, name, streaming, onOpenTranscript }) => {
  const { isZh } = useI18n();
  const runtime = useNeoxRuntimeOptional();
  const { user, task, pilot, pilotAfterUser } = useLastExchange();
  const cards = useStageCards();
  const [hint, setHint] = useState(true);
  const url = MODEL_URLS[look] ?? MODEL_URLS.cat;

  /* 手上有事在做 (工具在跑) = 埋头干活; 只在出字 = 说话; 两样都不是 = 在想 */
  const working = streaming && cards.some((c) => c.status === 'running');
  const mood: StageMood = !streaming ? 'idle' : working ? 'working' : pilotAfterUser ? 'talking' : 'thinking';
  const showPilot = pilotAfterUser || (!user && !!pilot);
  const line = showPilot ? pilot : user;
  const speaker = showPilot ? name : (isZh ? '你' : 'You');

  useEffect(() => {
    const t = setTimeout(() => setHint(false), 6000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className={`pilot-stage is-${mood}`} onPointerDown={() => setHint(false)}>
      <div className="pilot-stage__halo" aria-hidden />
      <Canvas
        className="pilot-stage__canvas"
        dpr={[1, 2]}
        camera={{ position: [0, 1.4, 5.8], fov: 35 }}
        gl={{ alpha: true, antialias: true }}
      >
        <hemisphereLight args={['#ffffff', '#d8d4cc', 1.7]} />
        <directionalLight position={[2.5, 4, 3]} intensity={2.2} />
        <directionalLight position={[-3, 2, -2]} intensity={0.5} />
        {/* 角色模型还在下: 先把地上的影子放出来 (Canvas 里只能放 3D 对象, 放不了 DOM 加载圈) */}
        <CharacterBoundary key={url} url={url}>
          <Suspense fallback={<ContactShadows position={[0, 0, 0]} opacity={0.2} scale={6} blur={2.6} far={2.5} />}>
            <Character url={url} mood={mood} />
            <ContactShadows position={[0, 0, 0]} opacity={0.35} scale={6} blur={2.6} far={2.5} />
          </Suspense>
        </CharacterBoundary>
        <FrameAboveDialog />
        <Controls />
      </Canvas>

      {hint && <div className="pilot-stage__hint">{isZh ? '拖动转着看 · 滚轮远近 · 双击回正' : 'Drag to turn · scroll to zoom · double-click to reset'}</div>}

      {/* 左边: 它在干什么 / 干出了什么 (取代原来两侧的工具卡) */}
      {sessionId && <StageHeadline sessionId={sessionId} workspacePath={runtime?.workspacePath ?? ''} streaming={streaming} userText={task} cards={cards} />}

      {(line || streaming) && (
        <div
          className={`pilot-stage__dialog${showPilot ? ' is-pilot' : ' is-user'}`}
          role="button"
          tabIndex={0}
          title={isZh ? '看完整记录' : 'Show full transcript'}
          onClick={() => { if (!window.getSelection()?.toString()) onOpenTranscript(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') onOpenTranscript(); }}
        >
          <span className="pilot-stage__speaker">{speaker}</span>
          <svg className="pilot-stage__expand" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
          </svg>
          <div className="pilot-stage__line">
            {line || (isZh ? '…' : '…')}
            {streaming && showPilot && <span className="pilot-stage__caret" aria-hidden />}
          </div>
          {streaming && !showPilot && <div className="pilot-stage__thinking">{isZh ? `${name} 在想…` : `${name} is thinking…`}</div>}
        </div>
      )}
    </div>
  );
};

export default PilotStage;
