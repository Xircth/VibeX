import type { SearchableItem } from '@astryxdesign/core/Typeahead';

import { type ComposerTypeaheadOption } from '../sessionComposerTypeaheadOptions';
import {
  getSessionComposerStructuredTokenSegments,
  type SessionComposerStructuredToken,
  type SessionComposerStructuredTokenKind,
} from '../sessionComposerStructuredTokens';

export function toSearchableItem(
  option: ComposerTypeaheadOption
): SearchableItem {
  const kind = option.key.startsWith('slash-')
    ? 'slash'
    : option.key.startsWith('dollar-')
      ? 'dollar'
      : option.key.startsWith('agent-')
        ? 'agent_mention'
        : option.key.startsWith('plugin-')
          ? 'plugin_action'
          : option.key.startsWith('tag-')
            ? 'tag'
            : option.key.startsWith('conversation-')
              ? 'conversation'
              : option.key.startsWith('commit-')
                ? 'commit'
                : 'file';
  return {
    id: option.key,
    label: option.label,
    auxiliaryData: {
      insertText: option.insertText,
      description: option.description,
      kind,
      agentKind:
        kind === 'agent_mention'
          ? option.key.slice('agent-'.length)
          : undefined,
      execute: option.execute,
    },
  };
}

export type ComposerSearchItemData = {
  insertText?: string;
  description?: string;
  kind?: SessionComposerStructuredTokenKind;
  agentKind?: string;
  execute?: (args: string) => void | string | Promise<void | string>;
};

export function getTokenFromInsertText(
  insertText: string
): SessionComposerStructuredToken | null {
  const segment = getSessionComposerStructuredTokenSegments(insertText).find(
    (candidate) => candidate.kind === 'token'
  );
  return segment?.kind === 'token' ? segment.token : null;
}

export type PreviewElementTokenDetails = {
  dom?: string;
  selector?: string;
  source?: string;
  html?: string;
};

export function parsePreviewElementTokenDetails(
  token: SessionComposerStructuredToken
): PreviewElementTokenDetails {
  const context = token.value;
  const dom = context.match(/^- DOM:\s*(.+)$/m)?.[1]?.trim();
  const selector = context
    .match(/^- Selector:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^`|`$/g, '');
  const source = context
    .match(/^- Selected start:.*?\((?:`([^`]+)`|([^\n)]+))\)$/m)
    ?.slice(1)
    .find(Boolean)
    ?.trim();
  const html = context
    .match(/^- Element source:\s*\n```html\s*\n([\s\S]*?)\n```/m)?.[1]
    ?.trim();

  return { dom, selector, source, html };
}

export function getHoverableTokenFromEventTarget(
  target: EventTarget | null
): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>(
        '[data-astryx-token][data-token-kind="element"],' +
          ' [data-astryx-token][data-token-kind="quote"]'
      )
    : null;
}

export function getStructuredHoverToken(
  element: HTMLElement
): SessionComposerStructuredToken | null {
  const raw = element.dataset.astryxTokenValue;
  if (!raw) return null;
  const token = getTokenFromInsertText(raw);
  return token?.kind === 'element' || token?.kind === 'quote' ? token : null;
}

export function rectsOverlap(
  left: number,
  top: number,
  width: number,
  height: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>
): boolean {
  return (
    left < rect.right &&
    left + width > rect.left &&
    top < rect.bottom &&
    top + height > rect.top
  );
}
