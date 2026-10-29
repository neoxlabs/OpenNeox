/* eslint-disable */
/**
 * bake-icons — 从 @tabler/icons (MIT) 抽取我们用到的那些路径, 烘焙成一个 .ts 文件.
 *
 * 【为什么烘焙而不是运行时依赖】Tabler 有 11314 个 svg。我们用得到的是几十个,
 * 把整包拖进运行时既没必要也拖慢冷启动。烘焙成一份纯字符串常量后:
 *   · 运行时**零新增依赖** (@tabler/icons 只进 devDependencies)
 *   · agent 的 node 子进程不需要能访问 node_modules
 *   · 图标路径进 git, 每次改动都在 diff 里看得见
 * 这和仓库里 bakedSkills.generated.ts 是同一个套路。
 *
 * 【为什么换掉手画的】原来 24 个图标是我一笔一笔写的路径, 逐个看图时抓出**三个
 * 传达了错误意思**的: gear 画出来是个太阳、factory 读成柱状图、rocket 和 idea
 * 的灯泡分不清。手画图标的问题不是"不够好看", 是**画不准**, 而画不准的图标
 * 在传达错误信息 —— 这是明康从一开始就在说的那类问题。
 * 专业图标库是设计师画的、成体系的、笔画粗细统一的, 没有理由自己硬扛。
 *
 * 【语义层保留】对外仍然是我们自己的语义名 (warning / truck / gear …),
 * 不暴露 Tabler 的文件名。原因有两个:
 *   1. deckTools 的槽位说明和 SKILL 里已经写了这些名字, 换掉会破坏 agent 的用法
 *   2. 语义名是**我们对内容的分类**, 和某个图标库的命名习惯是两件事;
 *      将来换库或换某个图标的画法, 调用方不该受影响
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');            /* monorepo 根 */
const SRC = join(ROOT, 'node_modules', '@tabler', 'icons', 'icons', 'outline');
const OUT = join(HERE, '..', 'src', 'templates', 'icons.generated.ts');

/* 语义名 → Tabler 文件名。分组只是给人看的, 不影响产物。 */
const MAP = {
  /* ── 目标与结果 ── */
  target: 'target-arrow', growth: 'trending-up', check: 'circle-check',
  award: 'award', star: 'star', flag: 'flag',
  /* ── 人与组织 ── */
  people: 'users', team: 'users-group', home: 'home',
  school: 'school', hospital: 'building-hospital', bank: 'building-bank',
  store: 'building-store', community: 'building-community',
  /* ── 时间与计划 ── */
  time: 'clock', calendar: 'calendar', speed: 'gauge', refresh: 'refresh',
  /* ── 数据与分析 ── */
  chart: 'chart-bar', chartLine: 'chart-line', chartPie: 'chart-pie',
  report: 'report-analytics', database: 'database', search: 'search',
  filter: 'filter', eye: 'eye',
  /* ── 技术 ── */
  chip: 'cpu', cloud: 'cloud', network: 'topology-star-3',
  ai: 'brain', robot: 'robot', mobile: 'device-mobile', key: 'key',
  /* ── 流程与工具 ── */
  gear: 'settings', tool: 'tool', layers: 'stack-2', link: 'link',
  share: 'share', rocket: 'rocket',
  /* ── 文档与制度 ── */
  doc: 'file-text', book: 'book', certificate: 'certificate',
  clipboard: 'clipboard-check', mail: 'mail',
  /* ── 风险与合规 ── */
  warning: 'alert-triangle', info: 'info-circle', help: 'help-circle',
  shield: 'shield', lock: 'lock', scale: 'scale',
  /* ── 商业 ── */
  money: 'coin-yuan', wallet: 'wallet', basket: 'basket',
  handshake: 'heart-handshake', bell: 'bell', messages: 'messages',
  /* ── 产业与地理 ── */
  location: 'map-pin', globe: 'world', factory: 'building-factory-2',
  truck: 'truck', car: 'car', plane: 'plane', ship: 'ship', train: 'train',
  /* ── 自然与可持续 ── */
  leaf: 'leaf', plant: 'plant-2', sun: 'sun', water: 'droplet',
  fire: 'flame', recycle: 'recycle',
  /* ── 想法 ── */
  idea: 'bulb',
};

/* Tabler 每个 svg 的第一条 path 是一个**透明包围盒** (M0 0h24v24H0z, fill/stroke
 * 都是 none)。它在浏览器里只是撑住尺寸, 但到了我们这边会被当成一条真实路径画出来,
 * 结果是每个图标外面套一个方框。必须剔掉。 */
const BBOX = /^M0\s*0h24v24H0z$/;

const entries = [];
const missing = [];

for (const [name, file] of Object.entries(MAP)) {
  const p = join(SRC, `${file}.svg`);
  if (!existsSync(p)) { missing.push(`${name} → ${file}.svg`); continue; }
  const svg = readFileSync(p, 'utf8');
  const ds = [...svg.matchAll(/\sd="([^"]+)"/g)]
    .map((m) => m[1].trim())
    .filter((d) => !BBOX.test(d.replace(/\s+/g, ' ').trim()));
  if (ds.length === 0) { missing.push(`${name} → ${file}.svg (剔掉包围盒后没有路径)`); continue; }
  /* 多条 path 合成一条多子路径的 d —— 我们一个 Shape 画一个图标 */
  entries.push([name, ds.join(' ').replace(/\s+/g, ' ')]);
}

/* 缺任何一个都直接失败。静默少烘焙一个图标 = 调用方拿到 undefined 然后画出空白,
 * 那是这套引擎里最难查的一类问题。 */
if (missing.length) {
  console.error('[bake-icons] 以下映射取不到路径:\n  ' + missing.join('\n  '));
  process.exit(1);
}

const body = entries.map(([n, d]) => `  ${/^[a-zA-Z_$][\w$]*$/.test(n) ? n : JSON.stringify(n)}: '${d}',`).join('\n');

writeFileSync(OUT, `/* 自动生成, 不要手改 —— 改 scripts/bake-icons.mjs 后跑 npm run bake:icons */
/* eslint-disable */

/**
 * 图标路径烘焙自 Tabler Icons (https://tabler.io/icons) · MIT License
 * Copyright (c) 2020-2026 Paweł Kuna
 *
 * 全部是 24×24 outline, stroke-width 2 —— 和 iconGlyph 的 strokeOnly + border
 * 渲染方式一致。原 svg 里那条透明包围盒路径 (M0 0h24v24H0z) 已在烘焙时剔除:
 * 它在浏览器里只是撑尺寸, 到我们这边会被当成真实路径画出一个方框。
 */
export const TABLER_ICONS = {
${body}
} as const;
`, 'utf8');

console.log(`[bake-icons] ${entries.length} 个图标 → src/templates/icons.generated.ts`);
