export type TypeaheadTriggerMatch = {
  leadOffset: number;
  matchingString: string;
  replaceableString: string;
};

export type TypeaheadTrigger = '/' | '$' | '@' | '#';

const TRIGGER_PREFIX = String.raw`(?:^|[\s(])`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchTypeaheadTrigger(
  text: string,
  trigger: TypeaheadTrigger,
  blockedChars: string
): TypeaheadTriggerMatch | null {
  const escapedTrigger = escapeRegExp(trigger);
  const pattern = new RegExp(
    `${TRIGGER_PREFIX}${escapedTrigger}([^\\s${escapeRegExp(blockedChars)}]*)$`
  );
  const match = pattern.exec(text);
  if (!match) return null;

  const triggerOffset = match.index + match[0].indexOf(trigger);
  return {
    leadOffset: triggerOffset,
    matchingString: match[1],
    replaceableString: match[0].slice(match[0].indexOf(trigger)),
  };
}

export function matchSlashCommandTrigger(
  text: string
): TypeaheadTriggerMatch | null {
  return matchTypeaheadTrigger(text, '/', '/');
}

export function matchDollarCommandTrigger(
  text: string
): TypeaheadTriggerMatch | null {
  return matchTypeaheadTrigger(text, '$', '$');
}

export function matchFileReferenceTrigger(
  text: string
): TypeaheadTriggerMatch | null {
  return matchTypeaheadTrigger(text, '@', '#@');
}

export function matchTagReferenceTrigger(
  text: string
): TypeaheadTriggerMatch | null {
  return matchTypeaheadTrigger(text, '#', '#@');
}
