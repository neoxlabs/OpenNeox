/**
 * Resolve each streamed tool-call delta to a stable slot. Provider ids take
 * precedence over indexes, while id-less deltas attach to the current slot.
 * The tracker is independent of the runner and can be tested as a pure state
 * machine.
 */
export type ToolCallSlotDelta = { index?: number; id?: string };

export class ToolCallSlotTracker {
  private readonly slotById = new Map<string, number>();
  private readonly providerIdBySlot = new Map<number, string>();
  private highest = -1;

  /** 返回这条 delta 该落的槽位 (数组下标)。调用方负责在该下标上初始化/追加。 */
  resolve(delta: ToolCallSlotDelta): number {
    const id = delta.id;
    if (id) {
      const known = this.slotById.get(id);
      if (known !== undefined) return known;
    }
    let index = delta.index;
    if (index === undefined || index === null || !Number.isFinite(index)) {
      index = id ? this.highest + 1 : Math.max(0, this.highest);
    }
    if (id) {
      const occupant = this.providerIdBySlot.get(index);
      if (occupant !== undefined && occupant !== id) index = this.highest + 1;
      this.slotById.set(id, index);
      this.providerIdBySlot.set(index, id);
    }
    if (index > this.highest) this.highest = index;
    return index;
  }
}
