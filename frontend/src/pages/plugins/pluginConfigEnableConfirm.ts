const ITEM_COUNT_PATTERN = /(\d+)\s*(?:项技能|Skills)/i;

function positiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

export function pluginConfigEnableItemCount(
  schema: Record<string, unknown>,
  description?: string
): number | null {
  const annotated = positiveInt(schema['x-itemCount']);
  if (annotated != null) return annotated;

  const sources = [description, schema.description].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  for (const source of sources) {
    const match = source.match(ITEM_COUNT_PATTERN);
    if (!match) continue;
    const count = positiveInt(Number(match[1]));
    if (count != null) return count;
  }
  return null;
}
