export const COMPOSER_INSERT_EVENT = 'vibex:composer-insert';

export type ComposerInsertDetail = {
  text: string;
  mode?: 'text' | 'token';
  label?: string;
  conversationId?: string;
};

export function shouldAcceptComposerInsert(
  detail: ComposerInsertDetail | undefined,
  listener: {
    conversationId?: string | null;
    acceptExternalInserts?: boolean;
  }
): boolean {
  if (!detail) return false;
  if (listener.acceptExternalInserts === false) return false;
  if (!detail.conversationId) return true;
  return listener.conversationId === detail.conversationId;
}

export function requestComposerInsert(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const event = new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, {
    detail: { text: trimmed, mode: 'text' },
  });
  window.dispatchEvent(event);
  return true;
}

export function requestComposerTokenInsert(token: {
  value: string;
  label: string;
  conversationId?: string | null;
}): boolean {
  if (!token.value) return false;
  const event = new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, {
    detail: {
      text: token.value,
      mode: 'token',
      label: token.label,
      ...(token.conversationId ? { conversationId: token.conversationId } : {}),
    },
  });
  window.dispatchEvent(event);
  return true;
}
