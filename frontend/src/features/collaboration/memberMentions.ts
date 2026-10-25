export type MemberMentionSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; nickname: string };

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split plain text on `@nickname` tokens that exist in `knownNicknames`.
 * Unknown tokens such as `@我` stay ordinary text.
 */
export function splitTextByMemberMentions(
  text: string,
  knownNicknames: readonly string[]
): MemberMentionSegment[] {
  if (!text || !text.includes('@')) {
    return [{ type: 'text', value: text }];
  }
  const sortedNicknames = [...knownNicknames]
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (sortedNicknames.length === 0) {
    return [{ type: 'text', value: text }];
  }
  const alternation = sortedNicknames.map(escapeRegex).join('|');
  const knownRe = new RegExp(
    `(^|[^A-Za-z0-9_/@.])@(${alternation})(?=$|[^\\p{L}\\p{N}_-])`,
    'gu'
  );
  const parts: MemberMentionSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(knownRe)) {
    const matchIndex = match.index ?? 0;
    const prefix = match[1] ?? '';
    const nickname = match[2] ?? '';
    const fullMatch = match[0] ?? '';
    const mentionStart = matchIndex + prefix.length;
    if (mentionStart > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, mentionStart) });
    }
    parts.push({ type: 'mention', nickname });
    lastIndex = matchIndex + fullMatch.length;
  }
  if (parts.length === 0) {
    return [{ type: 'text', value: text }];
  }
  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return parts;
}
