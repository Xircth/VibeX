import { persistFrontendPreference } from '@/lib/frontendPreferences';
import { readLocalStorage, writeLocalStorage } from '@/lib/safeStorage';

/**
 * Monospace font selection (P3-2). Frontend-only, localStorage-persisted (mirrors
 * {@link ./uiZoom}). Sets the `--font-mono` CSS variable on the document root so
 * every `var(--font-mono)` usage (Tailwind `font-mono`, repointed CSS, and the
 * xterm terminal which reads the computed value) picks it up. Every option ends
 * in the bundled 'IBM Plex Mono' so an OS-absent font degrades gracefully.
 */
const BUNDLED_FALLBACK = `'IBM Plex Mono', monospace`;

export interface MonoFontOption {
  id: string;
  label: string;
  stack: string;
}

export const MONO_FONT_OPTIONS: MonoFontOption[] = [
  {
    id: 'default',
    label: 'IBM Plex Mono',
    stack: `'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`,
  },
  { id: 'sf-mono', label: 'SF Mono', stack: `'SF Mono', ${BUNDLED_FALLBACK}` },
  { id: 'menlo', label: 'Menlo', stack: `Menlo, ${BUNDLED_FALLBACK}` },
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    stack: `'JetBrains Mono', ${BUNDLED_FALLBACK}`,
  },
  {
    id: 'fira-code',
    label: 'Fira Code',
    stack: `'Fira Code', ${BUNDLED_FALLBACK}`,
  },
  {
    id: 'cascadia-code',
    label: 'Cascadia Code',
    stack: `'Cascadia Code', ${BUNDLED_FALLBACK}`,
  },
  { id: 'consolas', label: 'Consolas', stack: `Consolas, ${BUNDLED_FALLBACK}` },
];

const FONT_KEY = 'vibex:mono-font';
const DEFAULT_FONT_ID = 'default';

export function getMonoFontId(): string {
  const raw = readLocalStorage(FONT_KEY);
  return MONO_FONT_OPTIONS.some((option) => option.id === raw)
    ? (raw as string)
    : DEFAULT_FONT_ID;
}

function stackForId(id: string): string {
  return (
    MONO_FONT_OPTIONS.find((option) => option.id === id) ?? MONO_FONT_OPTIONS[0]
  ).stack;
}

export function applyMonoFont(id: string): void {
  document.documentElement.style.setProperty('--font-mono', stackForId(id));
}

export function setMonoFont(id: string): void {
  writeLocalStorage(FONT_KEY, id);
  persistFrontendPreference(FONT_KEY, id);
  applyMonoFont(id);
  // Let live consumers (open xterm terminals) re-read the variable.
  window.dispatchEvent(new CustomEvent('vibex:mono-font-changed'));
}

/** Apply the persisted mono font on startup. */
export function initMonoFont(): void {
  applyMonoFont(getMonoFontId());
}
