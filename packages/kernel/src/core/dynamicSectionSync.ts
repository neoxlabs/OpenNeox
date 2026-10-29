
export interface DynamicSectionMemory {
  upsertSystemTagged?(tag: string, content: string): void;
  removeSystemTagged?(tag: string): void;
  /** 带 `_tag` 的拷本 (ShortTermMemory.getAllForCopy); 没有就退化到 getAll */
  getAllForCopy?(): DynamicSectionMessage[];
  getAll?(): DynamicSectionMessage[];
}

export interface DynamicSectionMessage {
  role?: string;
  content?: unknown;
  _tag?: string;
}

/** 返回本轮生效的段 (已 trim); 空段返回 null。 */
export function syncDynamicSection(
  memory: DynamicSectionMemory,
  rawNext: string | undefined | null,
): string | null {
  const next = typeof rawNext === 'string' ? rawNext.trim() : '';
  if (!next) {
    memory.removeSystemTagged?.('dynamic_section');
    return null;
  }

  const messages = memory.getAllForCopy?.() ?? memory.getAll?.() ?? [];
  const hasTagged = messages.some((m) => m.role === 'system' && m._tag === 'dynamic_section');
  const inlinePresent = !hasTagged && messages.some((m) => (
    m.role === 'system'
    && !m._tag
    && typeof m.content === 'string'
    && m.content.includes(next)
  ));
  if (inlinePresent) return next;

  memory.upsertSystemTagged?.('dynamic_section', next);
  return next;
}
