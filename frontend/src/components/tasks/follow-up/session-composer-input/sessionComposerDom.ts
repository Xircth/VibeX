import {
  SESSION_COMPOSER_TOKEN_VARIANTS,
  appendSessionComposerTokenContents,
} from '../SessionComposerStructuredText';

import {
  formatSessionComposerCommand,
  getSessionComposerStructuredTokenSegments,
  type SessionComposerStructuredToken,
} from '../sessionComposerStructuredTokens';

import { type AtReferenceMember } from '../composerAtReferences';

import { getFileName } from './sessionComposerFiles';

export function fileReferenceTokenText(relativePath: string): string {
  return formatSessionComposerCommand({
    type: '@',
    key: getFileName(relativePath),
    value: relativePath,
  });
}

export function decorateStructuredTokenElement(
  element: HTMLElement,
  token: SessionComposerStructuredToken
) {
  element.dataset.tokenKind = token.kind;
  element.dataset.tokenValue = token.raw;
  if (token.kind === 'member_mention') {
    delete element.dataset.variant;
    element.removeAttribute('contenteditable');
    element.style.userSelect = 'text';
    element.style.webkitUserSelect = 'text';
    element.classList.add(
      'collaboration-member-mention-chip',
      'collaboration-composer-member-token'
    );
    element.dataset.memberMention = token.label;
    element.style.background = 'transparent';
    element.style.backgroundColor = 'transparent';
    element.style.padding = '0';
    element.style.borderRadius = '0';
    element.style.border = '0';
    element.style.boxShadow = 'none';
    element.querySelectorAll<HTMLElement>('span').forEach((childSpan) => {
      childSpan.style.background = 'transparent';
      childSpan.style.backgroundColor = 'transparent';
      childSpan.style.padding = '0';
      childSpan.style.borderRadius = '0';
      childSpan.style.border = '0';
      childSpan.style.boxShadow = 'none';
    });
    if (token.mentionAll) {
      element.dataset.mentionAll = 'true';
      element.classList.add('collaboration-member-mention-all');
      element.style.removeProperty('--member-mention-color');
      const isRestoredToken = element.hasAttribute(
        'data-astryx-restored-token'
      );
      if (isRestoredToken) {
        element.querySelector('.collaboration-member-mention-avatar')?.remove();
        element.querySelector('.session-composer-token-icon')?.remove();
      }
      const labelEl =
        element.querySelector<HTMLElement>(
          '.collaboration-member-mention-name, .astryx-chat-composer__token-label, .session-composer-token-label'
        ) ?? element.querySelector<HTMLElement>('span:last-of-type');
      if (labelEl) {
        labelEl.style.removeProperty('color');
        labelEl.style.removeProperty('--member-mention-color');
        labelEl.style.fontWeight = '700';
        const trimmedLabel = labelEl.textContent?.trim() ?? token.key;
        labelEl.textContent = trimmedLabel.startsWith('@')
          ? trimmedLabel
          : `@${trimmedLabel}`;
      }
    } else {
      delete element.dataset.mentionAll;
      element.classList.remove('collaboration-member-mention-all');
      if (token.memberAvatar?.color) {
        element.style.setProperty(
          '--member-mention-color',
          token.memberAvatar.color
        );
        const labelEl =
          element.querySelector<HTMLElement>(
            '.collaboration-member-mention-name, .astryx-chat-composer__token-label, .session-composer-token-label'
          ) ?? element.querySelector<HTMLElement>('span:last-of-type');
        if (labelEl) {
          labelEl.style.removeProperty('color');
          labelEl.style.setProperty(
            '--member-mention-color',
            token.memberAvatar.color
          );
          labelEl.style.fontWeight = '700';
        }
      }
    }
  } else {
    element.dataset.variant = SESSION_COMPOSER_TOKEN_VARIANTS[token.kind];
    element.classList.remove(
      'collaboration-member-mention-chip',
      'collaboration-composer-member-token',
      'collaboration-member-mention-all'
    );
    delete element.dataset.memberMention;
    delete element.dataset.mentionAll;
    element.style.removeProperty('--member-mention-color');
  }
  if (token.kind === 'element') {
    element.removeAttribute('title');
  } else if (token.title) {
    element.title = token.title;
  } else {
    element.removeAttribute('title');
  }
  if (token.kind === 'element') {
    element.dataset.previewElementToken = '';
    delete element.dataset.quoteToken;
    element.tabIndex = 0;
  } else if (token.kind === 'quote') {
    element.dataset.quoteToken = '';
    delete element.dataset.previewElementToken;
    element.tabIndex = 0;
  } else {
    delete element.dataset.previewElementToken;
    delete element.dataset.quoteToken;
    element.removeAttribute('tabindex');
  }
}

export function getSessionComposerEditable(
  composerRoot: HTMLDivElement | null
): HTMLElement | null {
  return (
    composerRoot?.querySelector<HTMLElement>(
      '[contenteditable="true"], [contenteditable="false"][role="combobox"]'
    ) ?? null
  );
}

export function prepareEmptyComposerForTokenInsert(editor: HTMLElement | null) {
  if (!editor) return;
  if (editor.querySelector('[data-astryx-token]')) return;
  const text = (editor.textContent ?? '').replace(/[\u200B\uFEFF\u00A0]/g, '');
  if (text.trim() !== '') return;
  // Empty contenteditables keep a caret <br>. insertToken then places the
  // chip after it, so serialize() starts with a newline and the token drops
  // to the second line.
  editor.replaceChildren();
}

export function appendPlainTextWithLineBreaks(
  parent: ParentNode,
  text: string
): void {
  const parts = text.split('\n');
  parts.forEach((part, index) => {
    if (index > 0) {
      parent.appendChild(document.createElement('br'));
    }
    if (part) {
      parent.appendChild(document.createTextNode(part));
    }
  });
}

export function getSerializedNodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').length;
  }
  if (node instanceof HTMLElement) {
    if (node.hasAttribute('data-astryx-token')) {
      return (
        Number(node.dataset.astryxTokenSourceLength) ||
        (node.dataset.astryxTokenValue ?? node.textContent ?? '').length
      );
    }
    if (node.nodeName === 'BR') {
      return 1;
    }
  }
  let total = 0;
  for (const child of Array.from(node.childNodes)) {
    total += getSerializedNodeLength(child);
  }
  return total;
}

export function getEditorCaretOffset(editor: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.endContainer)) return null;

  const targetContainer = range.endContainer;
  const targetOffset = range.endOffset;
  let offset = 0;
  let found = false;

  const visit = (node: Node): void => {
    if (found) return;
    if (node === targetContainer) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += Math.min(targetOffset, (node.textContent ?? '').length);
      } else {
        const children = Array.from(node.childNodes);
        for (let i = 0; i < Math.min(targetOffset, children.length); i += 1) {
          offset += getSerializedNodeLength(children[i]);
        }
      }
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += (node.textContent ?? '').length;
      return;
    }
    if (node instanceof HTMLElement) {
      if (node.hasAttribute('data-astryx-token')) {
        const len = getSerializedNodeLength(node);
        offset += len;
        if (node.contains(targetContainer)) {
          found = true;
        }
        return;
      }
      if (node.nodeName === 'BR') {
        offset += 1;
        return;
      }
    }
    for (const child of Array.from(node.childNodes)) {
      visit(child);
      if (found) return;
    }
  };

  visit(editor);
  return found ? offset : null;
}

export function restoreEditorCaretOffset(
  editor: HTMLElement,
  caretOffset: number | null
): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();

  if (caretOffset == null) {
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }

  let remaining = Math.max(0, caretOffset);
  const children = Array.from(editor.childNodes);
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.nodeType === Node.TEXT_NODE) {
      const len = (child.textContent ?? '').length;
      if (remaining <= len) {
        range.setStart(child, remaining);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      remaining -= len;
      continue;
    }
    const len = getSerializedNodeLength(child);
    if (remaining === 0) {
      range.setStart(editor, index);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    if (remaining < len) {
      range.setStart(editor, index + 1);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= len;
  }

  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function restoreStructuredTokens(
  composerRoot: HTMLDivElement,
  value: string,
  bareAgentMentions?: Array<{ agent_kind: string; display_name: string }>,
  savedCaretOffset?: number | null,
  spaceMembers?: AtReferenceMember[]
): void {
  const editor = getSessionComposerEditable(composerRoot);
  if (!editor) return;

  const segments = getSessionComposerStructuredTokenSegments(value, {
    bareAgentMentions,
    spaceMembers,
  });
  const tokenSegments = segments.filter((segment) => segment.kind === 'token');
  if (tokenSegments.length === 0) return;

  const existingTokens = Array.from(
    editor.querySelectorAll<HTMLElement>('[data-astryx-token]')
  );
  if (
    existingTokens.length === tokenSegments.length &&
    existingTokens.every(
      (element, index) =>
        (element.dataset.astryxTokenValue ||
          element.getAttribute('data-astryx-token') ||
          '') === tokenSegments[index].token.raw
    )
  ) {
    existingTokens.forEach((element, index) => {
      element.setAttribute(
        'data-astryx-token-source-length',
        String(tokenSegments[index].end - tokenSegments[index].start)
      );
      decorateStructuredTokenElement(element, tokenSegments[index].token);
    });
    return;
  }

  const hadPortalTokens = existingTokens.some((element) =>
    element.hasAttribute('data-astryx-token-id')
  );
  const wasFocused = document.activeElement === editor;
  const caretOffset = wasFocused
    ? (savedCaretOffset ?? getEditorCaretOffset(editor))
    : null;
  const fragment = document.createDocumentFragment();
  for (const segment of segments) {
    if (segment.kind === 'text') {
      appendPlainTextWithLineBreaks(fragment, segment.text);
      continue;
    }

    const token = document.createElement('span');
    token.setAttribute('data-astryx-token', '');
    token.setAttribute('data-astryx-token-value', segment.token.raw);
    token.setAttribute(
      'data-astryx-token-source-length',
      String(segment.end - segment.start)
    );
    token.setAttribute('data-astryx-restored-token', '');
    token.contentEditable = 'false';
    appendSessionComposerTokenContents(token, segment.token);
    decorateStructuredTokenElement(token, segment.token);
    fragment.append(token);
  }
  editor.replaceChildren(fragment);
  if (hadPortalTokens) {
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  if (wasFocused) {
    restoreEditorCaretOffset(editor, caretOffset);
  }
}

export function syncTriggerMenuWidth(composerRoot: HTMLDivElement): void {
  const width = composerRoot.getBoundingClientRect().width;
  if (width <= 0) return;

  const menu = composerRoot.querySelector('.astryx-trigger-menu');
  const popover = menu?.closest<HTMLElement>('[popover]');
  if (popover) {
    popover.style.width = `${Math.round(width)}px`;
  }
}
