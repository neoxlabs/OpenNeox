/** 将匹配模型显示名的配置值规范化为对应 id，其余值保持不变。 */
type ModelLike = { name?: string; id?: unknown };

export function toModelId(
  provider: { models?: ModelLike[] } | null | undefined,
  value: string | null | undefined,
): string | undefined {
  if (!value) return value ?? undefined;
  const models = provider?.models ?? [];
  if (models.some((m) => typeof m.id === 'string' && m.id === value)) return value;
  const byName = models.find((m) => m.name === value && typeof m.id === 'string' && m.id && m.id !== m.name);
  return byName ? (byName.id as string) : value;
}
