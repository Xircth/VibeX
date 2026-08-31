import { PANEL_IDS } from '@/stores/useLayoutStore';

export const TERMINAL_LIST_PANE_STORAGE_KEY = 'vibex.terminal.listPaneWidth';
export const TERMINAL_LIST_PANE_DEFAULT_WIDTH = 96;
export const TERMINAL_LIST_PANE_MIN_WIDTH = 72;
export const TERMINAL_LIST_PANE_MAX_WIDTH = 280;
export const TERMINAL_CONTENT_MIN_WIDTH = 160;

export type TerminalSurface = 'panel' | 'editor';

export function editorTerminalPanelId(tabId: string): string {
  return `${PANEL_IDS.TERMINAL}:${tabId}`;
}

export function isEditorTerminalPanelId(panelId: string): boolean {
  const prefix = `${PANEL_IDS.TERMINAL}:`;
  return panelId.startsWith(prefix) && panelId.length > prefix.length;
}

export function tabIdFromEditorTerminalPanelId(panelId: string): string | null {
  if (!isEditorTerminalPanelId(panelId)) {
    return null;
  }
  return panelId.slice(`${PANEL_IDS.TERMINAL}:`.length);
}

export function isWorkspacePanelTerminal(session: {
  surface?: TerminalSurface | null;
}): boolean {
  return session.surface !== 'editor';
}

export function clampTerminalListPaneWidth(
  width: number,
  containerWidth: number
): number {
  const rounded = Math.round(width);
  const minWidth = TERMINAL_LIST_PANE_MIN_WIDTH;
  const maxWidth = TERMINAL_LIST_PANE_MAX_WIDTH;
  if (
    !Number.isFinite(containerWidth) ||
    containerWidth <= minWidth + TERMINAL_CONTENT_MIN_WIDTH
  ) {
    return Math.min(Math.max(rounded, minWidth), maxWidth);
  }
  const maxAllowed = Math.min(
    maxWidth,
    Math.floor(containerWidth - TERMINAL_CONTENT_MIN_WIDTH)
  );
  return Math.min(Math.max(rounded, minWidth), maxAllowed);
}

export function readStoredTerminalListPaneWidth(): number {
  if (typeof window === 'undefined') {
    return TERMINAL_LIST_PANE_DEFAULT_WIDTH;
  }

  try {
    const raw = window.localStorage.getItem(TERMINAL_LIST_PANE_STORAGE_KEY);
    const parsed = raw == null ? Number.NaN : Number(raw);
    if (!Number.isFinite(parsed)) {
      return TERMINAL_LIST_PANE_DEFAULT_WIDTH;
    }
    return clampTerminalListPaneWidth(parsed, Number.POSITIVE_INFINITY);
  } catch {
    return TERMINAL_LIST_PANE_DEFAULT_WIDTH;
  }
}

export function persistTerminalListPaneWidth(width: number): void {
  try {
    window.localStorage.setItem(TERMINAL_LIST_PANE_STORAGE_KEY, String(width));
  } catch {
    // Width persistence is optional when storage is unavailable.
  }
}

export function terminalTitleSlug(shell?: string | null): string {
  if (!shell?.trim()) {
    return 'term';
  }

  const fileName =
    shell
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.replace(/\.(exe|cmd|bat)$/i, '') ?? 'term';
  const slug = fileName.trim().toLowerCase();
  return slug || 'term';
}

export function nextWorkspaceTerminalTitle(
  shell: string | null | undefined,
  existingTitles: readonly string[]
): string {
  const slug = terminalTitleSlug(shell);
  const used = new Set<number>();
  const prefix = `${slug}-`;
  for (const title of existingTitles) {
    if (!title.toLowerCase().startsWith(prefix)) {
      continue;
    }
    const suffix = title.slice(prefix.length);
    if (/^\d+$/.test(suffix)) {
      used.add(Number(suffix));
    }
  }

  let index = 1;
  while (used.has(index)) {
    index += 1;
  }
  return `${slug}-${String(index).padStart(2, '0')}`;
}

export function shouldCreateInitialTerminal(input: {
  panelVisible: boolean;
  sessionCount: number;
  isExternalShell: boolean;
}): boolean {
  return (
    input.panelVisible && input.sessionCount === 0 && !input.isExternalShell
  );
}

export function lastTerminalCloseHidesPanel(remainingCount: number): boolean {
  return remainingCount === 0;
}

export type TerminalBusyEvent =
  | { type: 'input'; data: string }
  | { type: 'output'; data: string };

const PROMPT_LINE = /[%$#>] ?$/;
const ESC = String.fromCharCode(0x1b);

export function reduceTerminalBusy(
  busy: boolean,
  event: TerminalBusyEvent
): boolean {
  if (event.type === 'input') {
    return /[\r\n]/.test(event.data) ? true : busy;
  }

  if (new RegExp(`${ESC}\\]133;[BD]`).test(event.data)) {
    return false;
  }

  const withoutCsi = event.data.replace(
    new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'),
    ''
  );
  const lines = withoutCsi
    .split(/\r?\n/)
    .map((line) => line.replace(/\r/g, '').trimEnd())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (last && PROMPT_LINE.test(last)) {
    return false;
  }
  return busy;
}
