export const COMPOSER_INSERT_EVENT = 'vibex:composer-insert';

export type ComposerInsertDetail = {
  text: string;
  mode?: 'text' | 'token';
  label?: string;
};

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
}): boolean {
  if (!token.value) return false;
  const event = new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, {
    detail: {
      text: token.value,
      mode: 'token',
      label: token.label,
    },
  });
  window.dispatchEvent(event);
  return true;
}
