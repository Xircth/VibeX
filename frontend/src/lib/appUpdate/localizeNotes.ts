const ENGLISH_HEADING = /^#{2,3}\s+english\s*$/i;
const CHINESE_HEADING = /^#{2,3}\s+(?:中文|chinese)\s*$/i;

function prefersChinese(locale: string): boolean {
  return locale.toLowerCase().split(/[-_]/)[0] === 'zh';
}

/**
 * VibeX release notes are published as one markdown body with `## English`
 * and `## 中文` halves. Show the half that matches the interface language;
 * otherwise keep the whole body.
 */
export function localizeReleaseNotes(body: string, locale: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';

  const lines = trimmed.replace(/\r\n?/g, '\n').split('\n');
  let englishStart = -1;
  let chineseStart = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (englishStart === -1 && ENGLISH_HEADING.test(line)) {
      englishStart = index + 1;
    } else if (chineseStart === -1 && CHINESE_HEADING.test(line)) {
      chineseStart = index + 1;
    }
  }

  if (englishStart === -1 || chineseStart === -1) {
    return trimmed;
  }

  const first = Math.min(englishStart, chineseStart);
  const english =
    englishStart < chineseStart
      ? lines
          .slice(englishStart, chineseStart - 1)
          .join('\n')
          .trim()
      : lines.slice(englishStart).join('\n').trim();
  const chinese =
    chineseStart < englishStart
      ? lines
          .slice(chineseStart, englishStart - 1)
          .join('\n')
          .trim()
      : lines.slice(chineseStart).join('\n').trim();

  const preferred = prefersChinese(locale) ? chinese : english;
  if (preferred) return preferred;

  // If the chosen half is empty, keep whatever came before the language
  // headings (usually a shared title) rather than going blank.
  return (
    lines
      .slice(0, first - 1)
      .join('\n')
      .trim() || trimmed
  );
}

export function isGenericUpdaterNotes(notes: string): boolean {
  return /^desktop installers for\b/i.test(notes.trim());
}
