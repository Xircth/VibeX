export type PreviewPanelMode = 'editor' | 'diff';

export type PreviewDiffViewMode = 'inline' | 'split';

export interface OpenFilePreviewOptions {
  mode?: PreviewPanelMode;
  diffViewMode?: PreviewDiffViewMode;
  modifiedContent?: string | null;
}

export interface PreviewPanelParams {
  filePath: string;
  mode: PreviewPanelMode;
  diffViewMode: PreviewDiffViewMode;
  modifiedContent: string | null;
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
  };
}
