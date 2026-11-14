/**
 * GFM table helpers. Projected message rows can insert blank lines between
 * table rows; the splitter and the block cache both need the compacted form so
 * a table stays one unit.
 */

export function markdownTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!trimmed.includes('|')) return [];

  const cells: string[] = [];
  let current = '';
  let index = 0;

  while (index < trimmed.length) {
    const char = trimmed[index];
    if (char === '`') {
      let run = 1;
      while (trimmed[index + run] === '`') run += 1;
      const marker = '`'.repeat(run);
      const close = trimmed.indexOf(marker, index + run);
      if (close !== -1) {
        current += trimmed.slice(index, close + run);
        index = close + run;
        continue;
      }
      current += marker;
      index += run;
      continue;
    }

    if (char === '\\' && trimmed[index + 1] === '|') {
      current += '\\|';
      index += 2;
      continue;
    }

    if (char === '|') {
      cells.push(current.trim());
      current = '';
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  cells.push(current.trim());
  return cells.length >= 2 ? cells : [];
}

export function isMarkdownTableSeparator(
  line: string,
  columnCount: number
): boolean {
  const cells = markdownTableCells(line);
  return (
    cells.length === columnCount &&
    cells.every((cell) => /^:?-{3,}:?$/u.test(cell))
  );
}

/**
 * Collapse blank lines that appear between rows of the same table. Only rows
 * whose cell count matches the header are pulled in, so an unrelated block
 * after the table is preserved verbatim.
 */
export function normalizeLooseTableRowsInText(value: string): string {
  if (!value.includes('|') || !/\n[ \t]*\n/.test(value)) {
    return value;
  }

  const lines = value.split('\n');
  const normalized: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const header = lines[index] ?? '';
    const headerCells = markdownTableCells(header);
    if (headerCells.length < 2) {
      normalized.push(header);
      index += 1;
      continue;
    }

    let separatorIndex = index + 1;
    while (lines[separatorIndex]?.trim() === '') separatorIndex += 1;
    if (
      separatorIndex >= lines.length ||
      !isMarkdownTableSeparator(lines[separatorIndex] ?? '', headerCells.length)
    ) {
      normalized.push(header);
      index += 1;
      continue;
    }

    normalized.push(header, lines[separatorIndex] ?? '');
    index = separatorIndex + 1;

    while (index < lines.length) {
      const gapStart = index;
      while (lines[index]?.trim() === '') index += 1;
      const row = lines[index];
      if (row && markdownTableCells(row).length === headerCells.length) {
        normalized.push(row);
        index += 1;
        continue;
      }

      normalized.push(...lines.slice(gapStart, index));
      break;
    }
  }

  return normalized.join('\n');
}
