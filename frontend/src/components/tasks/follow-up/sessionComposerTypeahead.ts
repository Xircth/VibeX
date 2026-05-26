import {
  matchDollarCommandTrigger,
  matchFileReferenceTrigger,
  matchSlashCommandTrigger,
  matchTagReferenceTrigger,
  type TypeaheadTriggerMatch,
} from '@/components/ui/wysiwyg/plugins/typeahead-triggers';

export type TextareaTypeaheadTrigger = '/' | '$' | '@' | '#';

export type TextareaTypeaheadState = {
  trigger: TextareaTypeaheadTrigger;
  match: TypeaheadTriggerMatch;
};

const MATCHERS: Record<
  TextareaTypeaheadTrigger,
  (text: string) => TypeaheadTriggerMatch | null
> = {
  '/': matchSlashCommandTrigger,
  $: matchDollarCommandTrigger,
  '@': matchFileReferenceTrigger,
  '#': matchTagReferenceTrigger,
};

export function getTextareaTypeaheadState(
  value: string,
  caretOffset: number
): TextareaTypeaheadState | null {
  const textBeforeCaret = value.slice(0, caretOffset);

  for (const trigger of ['/', '$', '@', '#'] as const) {
    const match = MATCHERS[trigger](textBeforeCaret);
    if (match) {
      return { trigger, match };
    }
  }

  return null;
}

export function replaceTextareaTypeaheadRange(
  value: string,
  match: TypeaheadTriggerMatch,
  replacement: string
): { value: string; caretOffset: number } {
  const start = match.leadOffset;
  const end = match.leadOffset + match.replaceableString.length;
  const hasFollowingWhitespace = /\s/.test(value.charAt(end));
  const replacementWithSpace = replacement.endsWith(' ')
    ? replacement
    : `${replacement} `;
  const normalizedReplacement =
    hasFollowingWhitespace && replacementWithSpace.endsWith(' ')
      ? replacementWithSpace.slice(0, -1)
      : replacementWithSpace;
  const nextValue =
    value.slice(0, start) + normalizedReplacement + value.slice(end);

  return {
    value: nextValue,
    caretOffset: start + normalizedReplacement.length,
  };
}
