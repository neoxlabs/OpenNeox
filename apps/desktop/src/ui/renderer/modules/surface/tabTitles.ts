/**
 * 标签重名消歧 —— 两个 index.ts 在标签栏上不能长得一模一样。
 * ═══════════════════════════════════════════════════════════════════════════
 * 文件标签的标题一直是**光秃秃的文件名**。可是 index.ts / types.ts / README.md
 * 这种名字在一个工程里遍地都是, 同时开两个, 标签栏上就是两个完全一样的 "index.ts",
 * 只能靠 hover 出 tooltip 才分得清 —— 这正是 IDE 早就解决掉的问题。
 *
 * 做法跟 IDE 一致: **只有重名时才加目录**, 而且只加到刚好能分开为止。
 *   a/index.ts + b/index.ts        → "index.ts — a"      "index.ts — b"
 *   x/a/index.ts + y/a/index.ts    → "index.ts — x/a"    "index.ts — y/a"   (一层还撞就再上一层)
 * 不重名的标签一个字都不动 —— 绝大多数情况下标签栏保持最短。
 */

/** 目录最多往上追几层. 追到头还撞 (比如同名文件在极深的镜像目录里) 就认了, 保持标题可读。 */
const MAX_PARENT_LEVELS = 3;

export interface TitledTab {
  /** 展示用标题 (通常是文件名) */
  title: string;
  /** 完整路径 / URL —— 没有就不参与消歧 (比如 about:blank 这种) */
  path?: string;
}

function segmentsOf(path: string): string[] {
  return path.split(/[/\\]/).filter(Boolean);
}

/** 取倒数第 2..(1+level) 段拼成后缀, 例如 level=1 → "a", level=2 → "x/a" */
function parentHint(path: string, level: number): string {
  const segs = segmentsOf(path);
  /* 最后一段是文件名本身, 不算 */
  const dirs = segs.slice(0, -1);
  if (dirs.length === 0) return '';
  return dirs.slice(Math.max(0, dirs.length - level)).join('/');
}

/**
 * 返回与入参等长的标题数组。不重名的原样返回。
 * 纯函数, 不碰 DOM 也不依赖 React —— 好测。
 */
export function disambiguateTabTitles<T extends TitledTab>(tabs: readonly T[]): string[] {
  const out = tabs.map(t => t.title);

  /* 按标题分组, 只处理撞名的那几组 */
  const byTitle = new Map<string, number[]>();
  tabs.forEach((t, i) => {
    const list = byTitle.get(t.title);
    if (list) list.push(i); else byTitle.set(t.title, [i]);
  });

  for (const idxs of byTitle.values()) {
    if (idxs.length < 2) continue;
    /* 没有路径的没法消歧, 也不该拖累别人 */
    const withPath = idxs.filter(i => !!tabs[i].path);
    if (withPath.length < 2) continue;

    for (let level = 1; level <= MAX_PARENT_LEVELS; level++) {
      const hints = withPath.map(i => parentHint(tabs[i].path!, level));
      const allDistinct = new Set(hints).size === hints.length && hints.every(h => h !== '');
      if (!allDistinct && level < MAX_PARENT_LEVELS) continue;
      withPath.forEach((i, k) => {
        if (hints[k]) out[i] = `${tabs[i].title} — ${hints[k]}`;
      });
      break;
    }
  }

  return out;
}
