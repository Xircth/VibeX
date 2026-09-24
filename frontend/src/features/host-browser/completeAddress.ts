/**
 * Bare Enter submits the address. Shift (including the IME switch key, which
 * can arrive as Enter with a Shift code) must not.
 */
export function isBrowserAddressSubmitKey(event: {
  key: string;
  code?: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  if (event.isComposing || event.key === 'Process' || event.keyCode === 229) {
    return false;
  }
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
    return false;
  }
  const code = event.code ?? '';
  if (code.startsWith('Shift')) return false;
  const enter =
    event.key === 'Enter' ||
    event.key === 'NumpadEnter' ||
    code === 'Enter' ||
    code === 'NumpadEnter';
  if (!enter) return false;
  return code === '' || code === 'Enter' || code === 'NumpadEnter';
}

/** Engine navigations update the address unless the person is mid-edit. */
export function shouldApplyNavigatedAddress(options: {
  engineUrl: string;
  addressFocused: boolean;
  addressDirty: boolean;
}): boolean {
  if (!options.engineUrl.trim()) return false;
  if (!options.addressFocused) return true;
  return !options.addressDirty;
}

/** Turn what a person typed into a URL the tab can open. */
export function completeBrowserAddress(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === 'about:blank') return trimmed;
  if (/^(javascript|data|file|vbscript):/i.test(trimmed)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
      if (trimmed === 'about:blank') return trimmed;
      return null;
    } catch {
      return null;
    }
  }
  if (/\s/.test(trimmed)) return null;
  const host = trimmed.split(/[/?#]/, 1)[0] ?? '';
  const looksLocal =
    host === 'localhost' ||
    host.startsWith('localhost:') ||
    /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(host);
  if (!host.includes('.') && !looksLocal) return null;
  const scheme = looksLocal ? 'http' : 'https';
  try {
    return new URL(`${scheme}://${trimmed}`).href;
  } catch {
    return null;
  }
}
