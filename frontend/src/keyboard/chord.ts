/**
 * Keyboard chord capture + display (P3-2 rebinding).
 *
 * A "chord" is a react-hotkeys-hook token like `meta+shift+enter` — the exact
 * form the registry ({@link ./registry}) already uses, so captured overrides
 * match at runtime. We derive the base key from `event.code` (the PHYSICAL key)
 * rather than `event.key`, because Shift transforms `event.key` (Shift + `/` →
 * `?`) which would never match the registry's `shift+slash`.
 *
 * Only keys in the registry's vocabulary are accepted; anything else returns
 * null so the UI can reject it instead of persisting an un-matchable chord.
 */

/** Physical `event.code` → react-hotkeys-hook base token. */
const CODE_TO_TOKEN: Record<string, string> = {
  Escape: 'esc',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Space: 'space',
  Slash: 'slash',
  Period: 'period',
  Comma: 'comma',
  // Must be 'backquote' (not 'backtick'): react-hotkeys-hook maps event.code
  // 'Backquote' → 'backquote' at match time, so any other token silently never fires.
  Backquote: 'backquote',
  Minus: 'minus',
  Equal: 'equal',
  Semicolon: 'semicolon',
  Quote: 'quote',
  BracketLeft: 'bracketleft',
  BracketRight: 'bracketright',
  Backslash: 'backslash',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
};

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift']);

interface ChordEventLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

function baseToken(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return CODE_TO_TOKEN[code] ?? null;
}

/**
 * Build a chord token from a keyboard event, or null when the event is only a
 * modifier press or an unsupported key.
 */
export function chordFromEvent(event: ChordEventLike): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const base = baseToken(event.code);
  if (!base) return null;

  const parts: string[] = [];
  if (event.metaKey) parts.push('meta');
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(base);
  return parts.join('+');
}

const TOKEN_DISPLAY: Record<string, string> = {
  meta: '⌘',
  ctrl: 'Ctrl',
  alt: '⌥',
  shift: '⇧',
  enter: 'Enter',
  esc: 'Esc',
  space: 'Space',
  slash: '/',
  period: '.',
  comma: ',',
  backquote: '`',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  tab: 'Tab',
  backspace: '⌫',
  delete: 'Del',
};

/** Render a chord token for display, e.g. `meta+shift+enter` → `⌘ ⇧ Enter`. */
export function formatChord(chord: string): string {
  return chord
    .split('+')
    .map((part) => TOKEN_DISPLAY[part] ?? (part.length === 1 ? part.toUpperCase() : part))
    .join(' ');
}
