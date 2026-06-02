import {
  matchDollarCommandTrigger,
  matchFileReferenceTrigger,
  matchSlashCommandTrigger,
  matchTagReferenceTrigger,
  type TypeaheadTriggerMatch,
} from '@/components/ui/wysiwyg/plugins/typeahead-triggers';
import type { SessionComposerStructuredTokenSegment } from './sessionComposerStructuredTokens';

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
  caretOffset: number,
  segments: SessionComposerStructuredTokenSegment[] = []
): TextareaTypeaheadState | null {
  const normalizedOffset = Math.max(0, Math.min(caretOffset, value.length));
  if (segments.length === 0) {
    return getMatchState(value.slice(0, normalizedOffset), 0);
  }

  let cursor = 0;
  for (const segment of segments) {
    if (segment.kind === 'text') {
      const start = cursor;
      const end = start + segment.text.length;
      if (normalizedOffset >= start && normalizedOffset <= end) {
        return getMatchState(
          segment.text.slice(0, normalizedOffset - start),
          start
        );
      }
      cursor = end;
      continue;
    }

    if (normalizedOffset > segment.start && normalizedOffset < segment.end) {
      return null;
    }

    cursor = segment.end;
  }

  return getMatchState(value.slice(0, normalizedOffset), 0);
}

function getMatchState(
  textBeforeCaret: string,
  rawStartOffset: number
): TextareaTypeaheadState | null {
  for (const trigger of ['/', '$', '@', '#'] as const) {
    const match = MATCHERS[trigger](textBeforeCaret);
    if (match) {
      return {
        trigger,
        match: {
          ...match,
          leadOffset: rawStartOffset + match.leadOffset,
        },
      };
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
