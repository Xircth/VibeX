import { imageExtensionForMime } from './clipboard';

export type MarkdownPasteRange = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

/** Structural subset of the Monaco editor used when inserting markdown. */
export interface MarkdownPasteEditor {
  getSelection(): MarkdownPasteRange | null;
  executeEdits(
    source: string,
    edits: Array<{
      range: MarkdownPasteRange;
      text: string;
      forceMoveMarkers?: boolean;
    }>
  ): boolean | null;
  pushUndoStop(): void;
  focus(): void;
}

export interface PastedImageWriteResult {
  file_name: string;
  markdown_path: string;
}

export type InsertPastedImagesAsMarkdownOptions = {
  editor: MarkdownPasteEditor;
  files: File[];
  /** Absolute directory of the markdown file (the future `assets/` sibling). */
  assetDir: string;
  /** Reads a file to a bare base64 body (no data: prefix). */
  readBase64: (file: File) => Promise<string>;
  /** Persists one image and returns its markdown-relative reference. */
  writeAsset: (
    directory: string,
    base64Content: string,
    extension: string
  ) => Promise<PastedImageWriteResult>;
};

/** Image MIME types that can be persisted next to a markdown file. */
const PASTEABLE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
]);

function markdownAlt(file: File): string {
  const stem = file.name.replace(/\.[^/.]+$/, '');
  return (stem || 'image').replace(/["\\\]]/g, '');
}

/**
 * Save pasted images into `<assetDir>/assets/` and insert markdown image
 * references at the editor's current cursor position. Returns how many images
 * were inserted (0 means nothing pasteable was present).
 *
 * One image becomes `![alt](assets/<name>)`; multiple images are joined on
 * their own lines. Undo is pushed as a single stop so one paste reverts as one
 * edit.
 */
export async function insertPastedImagesAsMarkdown({
  editor,
  files,
  assetDir,
  readBase64,
  writeAsset,
}: InsertPastedImagesAsMarkdownOptions): Promise<number> {
  const insertions: string[] = [];

  for (const file of files) {
    if (!PASTEABLE_IMAGE_TYPES.has(file.type)) {
      continue;
    }
    const extension = imageExtensionForMime(file.type);
    const base64 = await readBase64(file);
    const result = await writeAsset(assetDir, base64, extension);
    insertions.push(`![${markdownAlt(file)}](assets/${result.file_name})`);
  }

  if (insertions.length === 0) {
    return 0;
  }

  const text = insertions.join('\n');
  const range =
    editor.getSelection() ?? {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    };
  editor.executeEdits('vibex-paste-image', [
    { range, text, forceMoveMarkers: true },
  ]);
  editor.pushUndoStop();
  editor.focus();
  return insertions.length;
}
