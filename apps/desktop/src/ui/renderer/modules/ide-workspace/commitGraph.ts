
export interface GraphCommit {
  hash: string;
  parents: string[];
}

/** 一行画什么 */
export interface GraphRow {
  /** 这个提交自己在第几道 (0 = 最左) */
  lane: number;
  /** 本行总共要占多少道 —— 决定图区宽度 */
  width: number;
  /** 竖直穿过本行的道 (含自己那条的上下半段, 由 hasParentLine / hasChildLine 决定) */
  through: number[];
  /** 从本行的点斜着连到下一行某道 —— merge 的第二个父、以及新分出去的线 */
  forks: Array<{ from: number; to: number }>;
  /** 别的道在本行并进本提交这一道 —— 画成汇合的斜线 */
  merges: Array<{ from: number; to: number }>;
  /** 本提交是不是 merge (≥2 个父) —— 节点画大一圈/空心 */
  isMerge: boolean;
  /** 本提交有没有父在后面 (决定点的下方要不要继续画线) */
  hasParentLine: boolean;
}

function normalizeHashes(commits: readonly GraphCommit[]): GraphCommit[] {
  let min = Infinity;
  for (const c of commits) {
    if (c.hash) min = Math.min(min, c.hash.length);
    for (const p of c.parents) if (p) min = Math.min(min, p.length);
  }
  if (!Number.isFinite(min) || min === 0) return commits as GraphCommit[];
  /* 都一样长就不用动 (常态, 免得白拷一遍) */
  const allSame = commits.every(
    (c) => c.hash.length === min && c.parents.every((p) => p.length === min),
  );
  if (allSame) return commits as GraphCommit[];
  return commits.map((c) => ({
    hash: c.hash.slice(0, min),
    parents: c.parents.map((p) => p.slice(0, min)),
  }));
}

export function layoutCommitGraph(input: readonly GraphCommit[]): GraphRow[] {
  const commits = normalizeHashes(input);
  /** lanes[i] = 这条道正在等的 hash; null = 空闲 */
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];

  const firstFree = (): number => {
    const i = lanes.indexOf(null);
    if (i >= 0) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const c of commits) {
    /* 1. 谁在等我 */
    const waiting: number[] = [];
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) waiting.push(i);

    let lane: number;
    const merges: Array<{ from: number; to: number }> = [];
    if (waiting.length === 0) {
      /* 没人等 = 新的头 (HEAD 或另一条分支的顶端) */
      lane = firstFree();
    } else {
      lane = waiting[0]!;
      /* 其余的都并到最左这条来 */
      for (let k = 1; k < waiting.length; k++) {
        merges.push({ from: waiting[k]!, to: lane });
        lanes[waiting[k]!] = null;
      }
    }

    /* 穿过本行的道: 此刻还占着、且不是我自己这条 */
    const through: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] !== null) through.push(i);
    }

    /* 2. 安排父提交 */
    const forks: Array<{ from: number; to: number }> = [];
    if (c.parents.length === 0) {
      lanes[lane] = null;                       /* 根提交, 这条道到此为止 */
    } else {
      lanes[lane] = c.parents[0]!;              /* 第一个父继续占本道 */
      for (let p = 1; p < c.parents.length; p++) {
        /* merge 的其余父各开一条道。已经有道在等它就复用, 免得同一个父被两条线追 */
        const existing = lanes.indexOf(c.parents[p]!);
        const target = existing >= 0 ? existing : firstFree();
        lanes[target] = c.parents[p]!;
        forks.push({ from: lane, to: target });
      }
    }

    /* 尾部空闲道收缩, 免得图区宽度被历史峰值永久撑着 */
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    rows.push({
      lane,
      width: Math.max(lane + 1, lanes.length, ...through.map((t) => t + 1), 1),
      through,
      forks,
      merges,
      isMerge: c.parents.length >= 2,
      hasParentLine: c.parents.length > 0,
    });
  }

  return rows;
}

/** 整张图最宽多少道 —— 决定左侧图区留多宽 */
export function graphWidth(rows: readonly GraphRow[]): number {
  let w = 1;
  for (const r of rows) if (r.width > w) w = r.width;
  return w;
}

export const LANE_COLORS = [
  'color-mix(in srgb, var(--neox-fg-primary) 46%, transparent)',
  '#5B93C4',
  '#B98F4E',
  '#5E9B72',
  '#A47CAE',
  '#B8705F',
  '#4F9BA0',
] as const;

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length]!;
}
