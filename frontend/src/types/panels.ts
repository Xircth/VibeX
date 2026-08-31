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
}

export interface PreviewPanelParams {
  filePath: string;
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
}

/** Params for the Web Preview panel (built-in browser / dev-server preview). */
export interface WebPreviewPanelParams {
  /** URL the panel was asked to load (e.g. a link clicked in a conversation). */
  requestedUrl: string | null;
  /** Monotonic marker so re-opening the same URL re-applies it. */
  requestedUrlNonce: number;
  /** Favicon published by the active CEF page for the outer workspace tab. */
  faviconUrl?: string | null;
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
