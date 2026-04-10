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
