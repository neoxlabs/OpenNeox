/**
 * FileHotspotDetector — 检测"短时间内反复编辑同一文件"的低效循环
 *
 * 背景: LoopDetector 用 (toolName + args hash) 判 dedup, 但 edit_file 每次 line range
 * 略不同 → hash 不同 → 永远不算 duplicate. 日志显示 hook-flash.html 单文件 12 次独立
 * edit 流, LoopDetector 触发 318 次却拦下 0 次. 这是 hash-based 检测的盲区.
 *
 * 本模块补齐这个维度: 按 (sessionId, filePath) 维度做时间窗口计数, 只关注 mutation
 * 类工具 (edit_file/edit/write_file/write). 超阈值时注入 <system-reminder> 到 tool
 * result, 让下一轮 LLM 看到:"你正在小改一个文件很多次, 建议整体读+一次到位或重写".
 *
 * 不做硬拦截 (未来可选): 大 refactor 场景 5min 内可能合理编辑同文件 10 次, 硬拦会误伤.
 * 只加软提示, LLM 自己判断是不是该收敛.
 *
 * 触发阈值 (5min 滑动窗口):
 *   - count >= 5:  r1 温和提示
 *   - count >= 8:  r2 强化提示 (含文件名 + 计数)
 *   - count >= 12: r3 建议纯文本汇报当前状态 (不强停)
 */

// ============================================================================
// 阈值
// ============================================================================

export const FILE_HOTSPOT_WINDOW_MS = 5 * 60 * 1000; // 5min
export const FILE_HOTSPOT_R1_THRESHOLD = 5;
export const FILE_HOTSPOT_R2_THRESHOLD = 8;
export const FILE_HOTSPOT_R3_THRESHOLD = 12;

// ============================================================================
// Mutation 工具名 — 只这些工具的调用计入 hotspot
// ============================================================================

const MUTATION_TOOL_NAMES = new Set([
  'edit_file',
  'edit',
  'write_file',
  'write',
  'multi_edit',
  'multiEdit',
  /* Claude Code PascalCase remap 后的等价名, 覆盖 isProxyMode=true 场景 */
  'Edit',
  'Write',
  'MultiEdit',
]);

/** 判断某工具是否是文件 mutation 类. 供 runner 决定是否 recordTouch. */
export function isMutationTool(toolName: string): boolean {
  return MUTATION_TOOL_NAMES.has(toolName);
}

// ============================================================================
// Reminder 文本
// ============================================================================

function buildReminderR1(filePath: string, count: number): string {
  const shortPath = shortenPath(filePath);
  return `

<system-reminder>
你在最近 5 分钟内对 ${shortPath} 的同一片代码反复改了 ${count} 次.
这通常意味着改动方向不对, 在补漏. 建议:
1. 停下来重新 readfile 整个文件, 理解全貌
2. 一次性规划出完整改动, 用 write_file 覆盖或用单次 edit 写完全部差异
3. 或者思考是不是设计有问题, 与其小改不如整块重写
</system-reminder>`;
}

function buildReminderR2(filePath: string, count: number): string {
  const shortPath = shortenPath(filePath);
  return `

<system-reminder>
警告: 你已经对 ${shortPath} 编辑了 ${count} 次 (5min 内). 这是典型的"小改—再改—又改"死循环.
立即停下:
1. 用 readfile 读完整文件
2. 想清楚:目标是什么? 现在离目标差什么? 该如何一次到位?
3. 用 write_file 一次性写完 (或用一次覆盖全部改动的 edit)
不要再做增量小改.
</system-reminder>`;
}

function buildReminderR3(filePath: string, count: number): string {
  const shortPath = shortenPath(filePath);
  return `

<system-reminder>
你陷入了单文件编辑循环: ${shortPath} 已被编辑 ${count} 次 (5min 内), 没有明显收敛.
下一轮不要再调 edit_file / write_file. 给用户一段**纯文本**总结:
- 你在这个文件上想做什么
- 已经试了哪几种改法
- 为什么每次都又要改
- 需要用户提供什么信息 / 决策才能一次到位
</system-reminder>`;
}

// ============================================================================
// API
// ============================================================================

export interface HotspotCheckResult {
  /** 5min 窗口内该 filePath 累计 touch 次数 (含当前) */
  count: number;
  /** 拼好的 reminder 文本, null = 没到阈值不需要提示 */
  reminder: string | null;
  /** 触发级别 */
  level: 'none' | 'r1' | 'r2' | 'r3';
  /** 是否建议 runner 强制停 turn — 当前始终 false (不做硬拦截, 由 LLM 自行判定) */
  forceStop: boolean;
}

/** 一次编辑动到的行段 (编辑后坐标, 1-indexed, 含首尾) */
export interface EditRegion {
  start: number;
  end: number;
}

/** 两次编辑的行段相距这么近就算"改回同一处" (前面的编辑会让行号漂几行) */
const REWORK_LINE_MARGIN = 3;

interface Touch {
  ts: number;
  /** undefined = 不知道改了哪几行 (write_file 覆盖 / 结果里没有行号) */
  regions?: EditRegion[];
  /** Whether this edit overlaps an earlier region and counts as rework. */
  rework: boolean;
}

function overlaps(a: EditRegion[], b: EditRegion[]): boolean {
  return a.some((x) => b.some((y) => x.start <= y.end + REWORK_LINE_MARGIN && y.start <= x.end + REWORK_LINE_MARGIN));
}

export class FileHotspotDetector {
  private touches: Map<string, Touch[]> = new Map();
  private stats = { r1: 0, r2: 0, r3: 0 };

  /**
   * 记录一次文件 touch (edit/write 类操作), 并返回是否需要注入 reminder.
   *
   * Only overlapping regions count as rework; edits to different regions represent
   * progress. When regions are unavailable, each write keeps the conservative count.
   *
   * @param filePath 绝对或相对路径, 归一化交给调用方 (通常 tool 参数 file_path 直接用即可)
   * @param nowMs 当前时间戳 (默认 Date.now()), 测试可传固定值
   * @param regions 本次编辑动到的行段
   */
  recordAndCheck(filePath: string, nowMs: number = Date.now(), regions?: EditRegion[]): HotspotCheckResult {
    if (!filePath) {
      return { count: 0, reminder: null, level: 'none', forceStop: false };
    }
    const windowStart = nowMs - FILE_HOTSPOT_WINDOW_MS;
    let arr = this.touches.get(filePath);
    if (!arr) {
      arr = [];
      this.touches.set(filePath, arr);
    }
    /* 滑动窗口: 剥掉 5min 前的老记录 */
    while (arr.length > 0 && arr[0].ts < windowStart) {
      arr.shift();
    }
    const known = regions && regions.length > 0 ? regions : undefined;
    const rework = !known
      || arr.some((t) => !t.regions || overlaps(t.regions, known));
    arr.push({ ts: nowMs, regions: known, rework });
    if (!rework) {
      return { count: arr.filter((t) => t.rework).length, reminder: null, level: 'none', forceStop: false };
    }
    const count = arr.filter((t) => t.rework).length;

    /* 分级判定 — 到阈值再算一次 (每 3 次触发一次 reminder 避免刷屏).
     *   r1: count===5 or count===7 (温和期)
     *   r2: count===8 or count===10
     *   r3: count>=12 每 3 次
     *   同一档不重复扰动, 只在跨阈值时和"间隔 3 次" (温和的进一步提醒) 时触发. */
    let reminder: string | null = null;
    let level: HotspotCheckResult['level'] = 'none';

    if (count >= FILE_HOTSPOT_R3_THRESHOLD) {
      /* 每 3 次触发一次 */
      if ((count - FILE_HOTSPOT_R3_THRESHOLD) % 3 === 0) {
        reminder = buildReminderR3(filePath, count);
        level = 'r3';
        this.stats.r3++;
      }
    } else if (count >= FILE_HOTSPOT_R2_THRESHOLD) {
      if (count === FILE_HOTSPOT_R2_THRESHOLD || count === FILE_HOTSPOT_R2_THRESHOLD + 2) {
        reminder = buildReminderR2(filePath, count);
        level = 'r2';
        this.stats.r2++;
      }
    } else if (count >= FILE_HOTSPOT_R1_THRESHOLD) {
      if (count === FILE_HOTSPOT_R1_THRESHOLD || count === FILE_HOTSPOT_R1_THRESHOLD + 2) {
        reminder = buildReminderR1(filePath, count);
        level = 'r1';
        this.stats.r1++;
      }
    }

    return { count, reminder, level, forceStop: false };
  }

  /** 清空所有计数 — context compact 或 session reset 时调用. */
  reset(): void {
    this.touches.clear();
    this.stats = { r1: 0, r2: 0, r3: 0 };
  }

  /** 调试/观测: 获取当前统计 */
  getStats(): { r1: number; r2: number; r3: number; trackedFiles: number } {
    return { ...this.stats, trackedFiles: this.touches.size };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function shortenPath(filePath: string, maxLen = 60): string {
  if (filePath.length <= maxLen) return filePath;
  /* 保留末尾, 前面用 ... 省略 (文件名比路径头更有辨识度) */
  return '...' + filePath.slice(filePath.length - maxLen + 3);
}
