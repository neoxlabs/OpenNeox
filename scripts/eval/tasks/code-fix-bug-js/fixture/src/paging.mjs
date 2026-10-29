export function paginate(items, pageSize) {
  if (!Number.isInteger(pageSize) || pageSize <= 0) return [];
  const pages = [];
  for (let i = 0; i < items.length; i += pageSize) {
    pages.push(items.slice(i, i + pageSize - 1));
  }
  return pages;
}

export function pageCount(total, pageSize) {
  if (pageSize <= 0) return 0;
  return Math.floor(total / pageSize);
}
