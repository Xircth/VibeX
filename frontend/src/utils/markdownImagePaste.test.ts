import { describe, expect, it, vi } from 'vitest';
import {
  insertPastedImagesAsMarkdown,
  type MarkdownPasteEditor,
} from './markdownImagePaste';

const RANGE = {
  startLineNumber: 3,
  startColumn: 1,
  endLineNumber: 3,
  endColumn: 1,
};

function makeEditor() {
  const edits: Array<{ range: unknown; text: string }> = [];
  const editor: MarkdownPasteEditor = {
    getSelection: () => RANGE,
    executeEdits: ((_source: string, newEdits) => {
      edits.push(...newEdits);
      return true;
    }) as MarkdownPasteEditor['executeEdits'],
    pushUndoStop: vi.fn(),
    focus: vi.fn(),
  };
  return { editor, edits };
}

function makeFile(name: string, type: string): File {
  return new File(['fake-image-bytes'], name, { type });
}

describe('insertPastedImagesAsMarkdown', () => {
  it('writes one image to assets and inserts its markdown reference', async () => {
    const { editor, edits } = makeEditor();
    const readBase64 = vi.fn(async () => 'aGk=');
    const writeAsset = vi.fn(async () => ({
      file_name: 'pasted-image.png',
      markdown_path: 'assets/pasted-image.png',
    }));

    const count = await insertPastedImagesAsMarkdown({
      editor,
      files: [makeFile('shot.png', 'image/png')],
      assetDir: 'C:/docs',
      readBase64,
      writeAsset,
    });

    expect(count).toBe(1);
    expect(readBase64).toHaveBeenCalledTimes(1);
    expect(writeAsset).toHaveBeenCalledWith('C:/docs', 'aGk=', 'png');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({
      range: RANGE,
      text: '![shot](assets/pasted-image.png)',
      forceMoveMarkers: true,
    });
    expect(editor.pushUndoStop).toHaveBeenCalled();
    expect(editor.focus).toHaveBeenCalled();
  });

  it('joins multiple images onto separate lines', async () => {
    const { editor, edits } = makeEditor();
    const writeAsset = vi.fn(async (_directory: string, _b64: string, ext: string) => ({
      file_name: `pasted-image-${ext}-1.${ext}`,
      markdown_path: `assets/pasted-image-${ext}-1.${ext}`,
    }));

    const count = await insertPastedImagesAsMarkdown({
      editor,
      files: [
        makeFile('a.png', 'image/png'),
        makeFile('b.jpeg', 'image/jpeg'),
      ],
      assetDir: '/docs',
      readBase64: async (file) => `b64:${file.name}`,
      writeAsset,
    });

    expect(count).toBe(2);
    expect(edits[0].text).toBe(
      '![a](assets/pasted-image-png-1.png)\n![b](assets/pasted-image-jpg-1.jpg)'
    );
  });

  it('skips non-raster images (e.g. svg) and pastes nothing when empty', async () => {
    const { editor, edits } = makeEditor();
    const writeAsset = vi.fn();

    const svgCount = await insertPastedImagesAsMarkdown({
      editor,
      files: [makeFile('vector.svg', 'image/svg+xml')],
      assetDir: '/docs',
      readBase64: async () => 'x',
      writeAsset,
    });
    expect(svgCount).toBe(0);
    expect(edits).toHaveLength(0);

    const emptyCount = await insertPastedImagesAsMarkdown({
      editor,
      files: [],
      assetDir: '/docs',
      readBase64: async () => 'x',
      writeAsset,
    });
    expect(emptyCount).toBe(0);
    expect(edits).toHaveLength(0);
  });
});
