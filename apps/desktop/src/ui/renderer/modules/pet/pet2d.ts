/**
 * pet2d — 2D 桌宠的程序化生成器 + canvas 渲染器
 *
 * 没有外部美工资源时, 用 canvas 画几何 + 调色板组合 "卡通生物". 视觉风格偏
 * 圆胖 chibi (类似 Crossy Road / Stardew NPC 简化版), 不是真·像素艺术也不是
 * 真·矢量插画, 但每只长得**真的不一样** (千万种组合), 可拖可动可表情.
 *
 * 后续真有美工 sprite sheet 资源, drawPet2D() 替换成 ctx.drawImage(frame) 即可,
 * Pet2DSpec / Pet2DSprite 上层都不动.
 */

/* ============================================================
 * Spec — 一只 2D 桌宠的全部参数. 用户 roll 一只 = 随机出来一个 spec.
 *   JSON.stringify(spec) 持久化到 localStorage (cfg.savedPet2Ds), 每次都能
 *   重现一模一样的宠物 — 跟 Minecraft seed 同理.
 * ============================================================ */

export type Pet2DBody = 'round' | 'oval' | 'puffy' | 'tall';
export type Pet2DEars = 'none' | 'pointy' | 'floppy' | 'round' | 'antenna';
export type Pet2DEye  = 'dots' | 'big' | 'sleepy' | 'sparkle' | 'closed';
export type Pet2DMouth = 'smile' | 'open' | 'tongue' | 'flat' | 'cat';
export type Pet2DAccessory = 'none' | 'bowtie' | 'flower' | 'star' | 'crown';

export interface Pet2DSpec {
  /** 持久化 id (跟 customSkins 一样 'pet2d-<uuid>'), 用作 cfg.skin 时识别 */
  id: string;
  /** 用户自己给的名字 / 默认 "2D 桌宠 #abcd" */
  name: string;
  body: Pet2DBody;
  ears: Pet2DEars;
  eyes: Pet2DEye;
  mouth: Pet2DMouth;
  accessory: Pet2DAccessory;
  /** 0-1 主色 hue */
  hue: number;
  /** 0.4-0.8 主色 saturation */
  saturation: number;
  /** 0.55-0.8 主色 lightness */
  lightness: number;
  /** 0.85-1.15 头身比, 控制圆胖瘦高 */
  bodyScale: number;
  /** 0-1 装饰色 hue (跟主色 complementary) */
  accentHue: number;
  /** 时间戳, "我的 2D 桌宠" 列表排序用 */
  createdAt: number;
}

/* ============================================================
 * 随机生成
 * ============================================================ */

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const BODIES: readonly Pet2DBody[] = ['round', 'oval', 'puffy', 'tall'];
const EARS: readonly Pet2DEars[] = ['none', 'pointy', 'floppy', 'round', 'antenna'];
const EYES: readonly Pet2DEye[] = ['dots', 'big', 'sleepy', 'sparkle'];
const MOUTHS: readonly Pet2DMouth[] = ['smile', 'open', 'tongue', 'flat', 'cat'];
const ACCESSORIES: readonly Pet2DAccessory[] = ['none', 'none', 'none', 'bowtie', 'flower', 'star', 'crown'];
/* 'none' 重复 3 次 — 让大多数桌宠不带配饰, 视觉更干净 (~57% 概率无配饰) */

function uuid4(): string {
  /* 简易 UUID v4 — 不依赖 crypto module, renderer 友好 */
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function randomPet2DSpec(): Pet2DSpec {
  const id = `pet2d-${uuid4()}`;
  const hue = Math.random();
  return {
    id,
    name: `2D 桌宠 #${id.slice(-4)}`,
    body: pick(BODIES),
    ears: pick(EARS),
    eyes: pick(EYES),
    mouth: pick(MOUTHS),
    accessory: pick(ACCESSORIES),
    hue,
    saturation: 0.4 + Math.random() * 0.4,
    lightness: 0.55 + Math.random() * 0.25,
    bodyScale: 0.85 + Math.random() * 0.3,
    accentHue: (hue + 0.4 + Math.random() * 0.2) % 1, /* complementary-ish */
    createdAt: Date.now(),
  };
}

/* ============================================================
 * Canvas 渲染
 *   drawPet2D(ctx, spec, frame, size)
 *     · frame 0-1 浮点, 用于 idle 上下 bob / 眨眼周期 / 嘴动等
 *     · size 是 canvas 边长 (会被 dpr 乘到实际像素)
 * ============================================================ */

function hsl(h: number, s: number, l: number, a = 1): string {
  return `hsla(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${a})`;
}

/** mood → 帧动作行为映射. 让同一 spec 在不同 mood 下表现不同. */
export type Pet2DMood = 'idle' | 'happy' | 'sleeping' | 'error' | 'speaking' | 'thinking';

interface FrameMod {
  bobY: number;          /* 上下 bob 偏移 (相对 size 比例, e.g. 0.04 = 4% size) */
  squashX: number;       /* 横向 squash (1 = 不动, 0.9 = 压扁 10%) */
  squashY: number;
  rotation: number;      /* 弧度 */
  eyesClosed: boolean;   /* 眨眼瞬间 / 睡眠 */
  mouthOpen: number;     /* 0-1 嘴张多大 */
}

function computeFrameMod(spec: Pet2DSpec, mood: Pet2DMood, t: number): FrameMod {
  /* 默认 idle: 缓慢 sine bob + 周期眨眼 (3s 一次, 持续 100ms) */
  const idleBob = Math.sin(t * 2 * Math.PI) * 0.025;
  const blinkPhase = (t * 1.5) % 3;
  const blinkActive = blinkPhase < 0.1;
  const baseMod: FrameMod = {
    bobY: idleBob,
    squashX: 1,
    squashY: 1,
    rotation: 0,
    eyesClosed: blinkActive,
    mouthOpen: 0,
  };
  switch (mood) {
    case 'happy':
      /* 跳跃: |sin| 起伏, 落地时 squash */
      const jumpT = Math.abs(Math.sin(t * 4 * Math.PI));
      return {
        ...baseMod,
        bobY: -jumpT * 0.12,
        squashX: jumpT > 0.9 ? 1.1 : 1,
        squashY: jumpT > 0.9 ? 0.9 : 1,
        eyesClosed: false,
        mouthOpen: 0.6,
      };
    case 'sleeping':
      return {
        ...baseMod,
        bobY: Math.sin(t * 0.5 * Math.PI) * 0.015,
        eyesClosed: true,
        mouthOpen: 0,
      };
    case 'error':
      /* 抖动 — 短促左右 + 嘴张 */
      return {
        ...baseMod,
        rotation: Math.sin(t * 30 * Math.PI) * 0.1,
        eyesClosed: false,
        mouthOpen: 0.4,
      };
    case 'speaking':
      /* 嘴 0/1 切换, 头微点 */
      return {
        ...baseMod,
        mouthOpen: (Math.sin(t * 8 * Math.PI) + 1) / 2 * 0.7,
        rotation: Math.sin(t * 2 * Math.PI) * 0.03,
      };
    case 'thinking':
      /* 头稍仰, 眼睛上飘 */
      return {
        ...baseMod,
        rotation: -0.05,
      };
    default:
      return baseMod;
  }
}

/** 主绘制 — 一帧的 sprite. 把 canvas 当 80×80 单位空间画, 然后 scale 到实际 size. */
export function drawPet2D(
  ctx: CanvasRenderingContext2D,
  spec: Pet2DSpec,
  mood: Pet2DMood,
  t: number,
  size: number,
): void {
  const mod = computeFrameMod(spec, mood, t);
  ctx.save();
  ctx.clearRect(0, 0, size, size);

  /* 80×80 内部坐标系, 给后续逻辑用 nice 数 */
  const k = size / 80;
  ctx.translate(size / 2, size / 2 + mod.bobY * size);
  ctx.rotate(mod.rotation);
  ctx.scale(mod.squashX, mod.squashY);
  ctx.scale(spec.bodyScale * k, spec.bodyScale * k);

  const bodyColor = hsl(spec.hue, spec.saturation, spec.lightness);
  const shadowColor = hsl(spec.hue, spec.saturation * 0.9, Math.max(0.25, spec.lightness - 0.3), 0.35);
  const accentColor = hsl(spec.accentHue, spec.saturation, Math.min(0.7, spec.lightness + 0.1));
  const outlineColor = hsl(spec.hue, spec.saturation * 0.7, Math.max(0.2, spec.lightness - 0.45));

  /* 阴影 — 椭圆贴地 */
  ctx.fillStyle = shadowColor;
  ctx.beginPath();
  ctx.ellipse(0, 28, 22, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  /* 身体 */
  drawBody(ctx, spec.body, bodyColor, outlineColor);

  /* 耳朵 */
  drawEars(ctx, spec.ears, bodyColor, outlineColor);

  /* 眼睛 */
  drawEyes(ctx, spec.eyes, mod.eyesClosed, outlineColor);

  /* 嘴 */
  drawMouth(ctx, spec.mouth, mod.mouthOpen, outlineColor);

  /* 配饰 */
  drawAccessory(ctx, spec.accessory, accentColor, outlineColor);

  ctx.restore();
}

function drawBody(ctx: CanvasRenderingContext2D, body: Pet2DBody, fill: string, stroke: string) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  switch (body) {
    case 'round':
      ctx.arc(0, 0, 26, 0, Math.PI * 2);
      break;
    case 'oval':
      ctx.ellipse(0, 0, 22, 28, 0, 0, Math.PI * 2);
      break;
    case 'puffy':
      /* 4 个 lobes 拼出来云朵感 */
      ctx.arc(-12, -6, 16, 0, Math.PI * 2);
      ctx.moveTo(28, -6); ctx.arc(12, -6, 16, 0, Math.PI * 2);
      ctx.moveTo(16, 12); ctx.arc(0, 12, 16, 0, Math.PI * 2);
      ctx.moveTo(14, 0); ctx.arc(0, 0, 14, 0, Math.PI * 2);
      break;
    case 'tall':
      ctx.ellipse(0, 0, 18, 32, 0, 0, Math.PI * 2);
      break;
  }
  ctx.fill();
  ctx.stroke();
}

function drawEars(ctx: CanvasRenderingContext2D, ears: Pet2DEars, fill: string, stroke: string) {
  if (ears === 'none') return;
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.2;
  if (ears === 'pointy') {
    /* 两个三角 */
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.moveTo(side * 14, -18);
      ctx.lineTo(side * 22, -28);
      ctx.lineTo(side * 8, -24);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });
  } else if (ears === 'floppy') {
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.ellipse(side * 18, -8, 7, 12, side * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  } else if (ears === 'round') {
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.arc(side * 18, -18, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  } else if (ears === 'antenna') {
    /* 中间一根天线 + 顶端球 */
    ctx.beginPath();
    ctx.moveTo(0, -22);
    ctx.lineTo(0, -34);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -36, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function drawEyes(ctx: CanvasRenderingContext2D, eyes: Pet2DEye, closed: boolean, stroke: string) {
  ctx.fillStyle = stroke;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  if (closed) {
    /* 一字线 */
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.moveTo(side * 8 - 4, -4);
      ctx.quadraticCurveTo(side * 8, -2, side * 8 + 4, -4);
      ctx.stroke();
    });
    return;
  }
  if (eyes === 'dots') {
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.arc(side * 8, -4, 2, 0, Math.PI * 2);
      ctx.fill();
    });
  } else if (eyes === 'big') {
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.arc(side * 8, -4, 4, 0, Math.PI * 2);
      ctx.fill();
      /* 高光 */
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(side * 8 - 1.2, -5.5, 1.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = stroke;
    });
  } else if (eyes === 'sleepy') {
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.ellipse(side * 8, -4, 4, 1.5, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  } else if (eyes === 'sparkle') {
    [-1, 1].forEach((side) => {
      /* 星星眼 — 4 角 */
      const cx = side * 8;
      const cy = -4;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 4);
      ctx.lineTo(cx + 1, cy - 1);
      ctx.lineTo(cx + 4, cy);
      ctx.lineTo(cx + 1, cy + 1);
      ctx.lineTo(cx, cy + 4);
      ctx.lineTo(cx - 1, cy + 1);
      ctx.lineTo(cx - 4, cy);
      ctx.lineTo(cx - 1, cy - 1);
      ctx.closePath();
      ctx.fill();
    });
  }
}

function drawMouth(ctx: CanvasRenderingContext2D, mouth: Pet2DMouth, openness: number, stroke: string) {
  ctx.strokeStyle = stroke;
  ctx.fillStyle = stroke;
  ctx.lineWidth = 1.5;
  const y = 6;
  if (mouth === 'flat') {
    ctx.beginPath();
    ctx.moveTo(-4, y);
    ctx.lineTo(4, y);
    ctx.stroke();
  } else if (mouth === 'smile') {
    ctx.beginPath();
    ctx.arc(0, y - 2, 5, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();
    if (openness > 0.3) {
      ctx.fillStyle = '#5a2030';
      ctx.beginPath();
      ctx.ellipse(0, y + 1, 4 * openness, 2.5 * openness, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (mouth === 'open') {
    ctx.fillStyle = '#5a2030';
    ctx.beginPath();
    ctx.ellipse(0, y, 3 + openness * 2, 2 + openness * 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (mouth === 'tongue') {
    /* 笑 + 伸舌 */
    ctx.beginPath();
    ctx.arc(0, y - 2, 5, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = '#e88098';
    ctx.beginPath();
    ctx.ellipse(0, y + 2, 2.5, 3, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (mouth === 'cat') {
    /* 猫嘴 ω */
    ctx.beginPath();
    ctx.moveTo(-4, y);
    ctx.quadraticCurveTo(-2, y + 3, 0, y);
    ctx.quadraticCurveTo(2, y + 3, 4, y);
    ctx.stroke();
  }
}

function drawAccessory(ctx: CanvasRenderingContext2D, acc: Pet2DAccessory, fill: string, stroke: string) {
  if (acc === 'none') return;
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  if (acc === 'bowtie') {
    /* 颈部蝴蝶结 */
    ctx.beginPath();
    ctx.moveTo(-7, 18);
    ctx.lineTo(-2, 14);
    ctx.lineTo(-2, 22);
    ctx.closePath();
    ctx.moveTo(7, 18);
    ctx.lineTo(2, 14);
    ctx.lineTo(2, 22);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (acc === 'flower') {
    /* 头顶小花 — 5 瓣 */
    const cx = 14;
    const cy = -22;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * 3, cy + Math.sin(a) * 3, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#ffe066';
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (acc === 'star') {
    /* 头顶一颗星星 */
    const cx = 0;
    const cy = -28;
    ctx.fillStyle = '#ffd84d';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? 4 : 1.8;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (acc === 'crown') {
    /* 头顶皇冠 */
    ctx.fillStyle = '#ffd84d';
    ctx.beginPath();
    ctx.moveTo(-12, -22);
    ctx.lineTo(-8, -30);
    ctx.lineTo(-4, -22);
    ctx.lineTo(0, -32);
    ctx.lineTo(4, -22);
    ctx.lineTo(8, -30);
    ctx.lineTo(12, -22);
    ctx.lineTo(12, -18);
    ctx.lineTo(-12, -18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}
