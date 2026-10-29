export function stableCardOrder(prev: readonly string[], next: readonly string[], newcomersFirst = false): string[] {
  const nextSet = new Set(next);
  const prevSet = new Set(prev);
  const newcomers = next.filter((id) => !prevSet.has(id));
  if (newcomersFirst) return [...newcomers, ...prev.filter((id) => nextSet.has(id))];
  const slots = prev.map((id) => (nextSet.has(id) ? id : null));
  for (let i = 0; i < slots.length && newcomers.length > 0; i++) {
    if (slots[i] === null) slots[i] = newcomers.shift()!;
  }
  return [...slots.filter((id): id is string => id !== null), ...newcomers];
}
