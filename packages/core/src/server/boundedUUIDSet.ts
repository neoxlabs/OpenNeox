/** 固定容量的 UUID 环形去重集合，用于回显与重连期间的重复消息过滤。 */

export class BoundedUUIDSet {
  private readonly capacity: number;
  private readonly ring: (string | undefined)[];
  private readonly set = new Set<string>();
  private writeIdx = 0;

  constructor(capacity = 2000) {
    this.capacity = Math.max(1, capacity);
    this.ring = new Array(this.capacity).fill(undefined);
  }

  /** 添加 UUID，满时 FIFO 淘汰最旧条目 */
  add(uuid: string): void {
    if (this.set.has(uuid)) return; // 已存在

    // 淘汰 ring[writeIdx] 的旧值
    const evicted = this.ring[this.writeIdx];
    if (evicted !== undefined) {
      this.set.delete(evicted);
    }

    this.ring[this.writeIdx] = uuid;
    this.set.add(uuid);
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
  }

  /** O(1) 判断是否存在 */
  has(uuid: string): boolean {
    return this.set.has(uuid);
  }

  /** 批量添加（预填充已知 ID） */
  seed(uuids: string[]): void {
    for (const uuid of uuids) {
      this.add(uuid);
    }
  }

  /** 当前已存储数量 */
  get size(): number {
    return this.set.size;
  }

  /** 清空 */
  clear(): void {
    this.set.clear();
    this.ring.fill(undefined);
    this.writeIdx = 0;
  }
}
