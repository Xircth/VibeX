import type { FileOpenLocation } from '@/components/file-tree/file-tree-types';

export type PreviewPanelMode = 'editor' | 'diff';

export type PreviewDiffViewMode = 'inline' | 'split';

export interface OpenFilePreviewOptions {
  mode?: PreviewPanelMode;
  diffViewMode?: PreviewDiffViewMode;
  modifiedContent?: string | null;
  originalContent?: string | null;
  displayPath?: string | null;
  title?: string | null;
  location?: FileOpenLocation | null;
  /**
   * Whether opening the file may move the user's attention to it. Pass false to
   * open a tab without stealing focus or moving the file tree selection.
   */
  activate?: boolean;
}

/** What `openFilePreview` did, or why it could not do anything. */
export type OpenFilePreviewResult = 'opened' | 'focused' | 'unavailable';

export interface PreviewPanelParams {
  filePath: string;
  renamedFrom?: string | null;
  mode: PreviewPanelMode;
  diffViewMode: PreviewDiffViewMode;
  modifiedContent: string | null;
  originalContent: string | null;
  displayPath: string | null;
  location: FileOpenLocation | null;
  /** Legacy serialized image source. New panels use imagePreviewId. */
  imageUrl?: string | null;
  /** Key into the in-memory image preview registry. */
  imagePreviewId?: string | null;
}

export type TerminalPanelSurface = 'panel' | 'editor';

/** Params for a workspace terminal opened as an editor-group tab. */
export interface TerminalPanelParams {
  surface?: TerminalPanelSurface;
  tabId?: string;
  /** Shell chosen when the tab was created. The panel shell list owns the values. */
  shell?: string;
  /** Marks the tab that was opened into the terminal shelf group. */
  terminalShelf?: boolean;
}

export function buildPreviewPanelParams(
  filePath: string,
  options?: OpenFilePreviewOptions
): PreviewPanelParams {
  return {
    filePath,
    mode: options?.mode ?? 'editor',
    diffViewMode: options?.diffViewMode ?? 'split',
    modifiedContent: options?.modifiedContent ?? null,
    originalContent: options?.originalContent ?? null,
    displayPath: options?.displayPath ?? null,
    location: options?.location ?? null,
  };
}
