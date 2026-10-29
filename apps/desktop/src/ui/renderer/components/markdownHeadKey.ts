/**
 * code:TIMELINE-08 —— 流式 Markdown 头部块的增量指纹。
 *
 * 流式时正文被切成块, 已写完的前 N-1 块各自 memo 住元素 (见 Markdown.tsx)。
 * 缓存失效判据原来是 `headBlocks.join('')` —— 每帧把整段正文重新拼一遍,
 * 20K 字就是每帧一次 20K 字符的分配; 正文越长, 帧越贵, 而每帧真正变化的
 * 只有末尾那几块。
 *
 * 这里换成分块链式指纹: 逐块比较内容找公共前缀, 只对新增/变化的块算哈希,
 * 前缀部分复用上一次的链值 —— 不拼接、不分配整段字符串。
 * 两个独立的 32 位累加器合成 64 位, 碰撞概率 2^-64 (单 32 位在长会话里
 * 是有可能撞的, 撞了就是渲染错块)。
 */

const OFFSET_A = 0x811c9dc5;
const OFFSET_B = 0x9e3779b9;
const PRIME_A = 0x01000193;
const PRIME_B = 0x85ebca6b;

/** 一个块的 64 位哈希 (两路 32 位)。 */
function hashBlock(s: string): [number, number] {
  /* 长度先拌进去: "ab"+"c" 与 "a"+"bc" 的块哈希必须不同 */
  let a = (OFFSET_A ^ s.length) >>> 0;
  let b = (OFFSET_B + s.length) >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, PRIME_A) >>> 0;
    b = Math.imul(b ^ c, PRIME_B) >>> 0;
  }
  return [a, b];
}

export interface HeadKeyTracker {
  /**
   * 传入当前头部块, 返回指纹。
   * 同一实例应跨帧复用 (放在 ref 里), 这样才能吃到前缀缓存。
   */
  update(blocks: string[]): string;
}

export function createHeadKeyTracker(): HeadKeyTracker {
  /** 上一次的块内容 (只用来找公共前缀) 与每一块之后的链值快照。 */
  let prevBlocks: string[] = [];
  let chainA: number[] = [OFFSET_A];
  let chainB: number[] = [OFFSET_B];

  return {
    update(blocks: string[]): string {
      const n = blocks.length;
      const prevLen = prevBlocks.length;
      const limit = Math.min(n, prevLen);

      /* 流式追加时前缀逐块相同; 内容被整体改写时通常第一块就不等了。
       * 字符串相等比较是原生的逐字比较, 不产生新字符串。 */
      let same = 0;
      while (same < limit && prevBlocks[same] === blocks[same]) same++;

      if (same < prevLen) {
        /* 变短或中途改写: 丢掉失效的链值快照, 从公共前缀之后重算 */
        chainA.length = same + 1;
        chainB.length = same + 1;
      }

      let a = chainA[same] ?? OFFSET_A;
      let b = chainB[same] ?? OFFSET_B;
      for (let i = same; i < n; i++) {
        const [ha, hb] = hashBlock(blocks[i]);
        a = Math.imul(a ^ ha, PRIME_A) >>> 0;
        b = Math.imul(b ^ hb, PRIME_B) >>> 0;
        chainA[i + 1] = a;
        chainB[i + 1] = b;
      }

      prevBlocks = blocks;

      /* 块数也进 key: 前缀相同但块数变少 (截断) 时链值可能相等, 靠 n 区分。 */
      let total = 0;
      for (let i = 0; i < n; i++) total += blocks[i].length;
      return `${n}:${a.toString(36)}${b.toString(36)}:${total}`;
    },
  };
}
