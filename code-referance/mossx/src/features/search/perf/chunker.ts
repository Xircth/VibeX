export function takeLimited<T>(items: readonly T[], limit: number): T[] {
  if (limit <= 0) {
    return [];
  }
  if (items.length <= limit) {
    return [...items];
  }
  return items.slice(0, limit);
}
