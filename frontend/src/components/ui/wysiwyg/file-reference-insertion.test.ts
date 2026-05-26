import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileReferencePayload } from '@/utils/fileReferences';
import type { LexicalEditor } from 'lexical';

const lexicalMocks = vi.hoisted(() => ({
  createFileReferenceNode: vi.fn(),
  createParagraphNode: vi.fn(),
  createTextNode: vi.fn(),
  getRoot: vi.fn(),
  getSelection: vi.fn(),
  isElementNode: vi.fn(),
  isRangeSelection: vi.fn(),
}));

vi.mock('lexical', () => ({
  $createParagraphNode: lexicalMocks.createParagraphNode,
  $createTextNode: lexicalMocks.createTextNode,
  $getRoot: lexicalMocks.getRoot,
  $getSelection: lexicalMocks.getSelection,
  $isElementNode: lexicalMocks.isElementNode,
  $isRangeSelection: lexicalMocks.isRangeSelection,
}));

vi.mock('./nodes/file-reference-node', () => ({
  $createFileReferenceNode: lexicalMocks.createFileReferenceNode,
}));

import { insertFileReferenceIntoEditor } from './file-reference-insertion';

const payload: FileReferencePayload = {
  fileName: 'README.md',
  relativePath: 'docs/README.md',
  kind: 'file',
};

function createEditor() {
  return {
    focus: vi.fn(),
    update: vi.fn((callback: () => void) => callback()),
  } as unknown as LexicalEditor & {
    focus: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

describe('file reference insertion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lexicalMocks.createFileReferenceNode.mockReturnValue({
      type: 'file-reference-node',
    });
    lexicalMocks.createTextNode.mockReturnValue({ type: 'space-node' });
    lexicalMocks.createParagraphNode.mockReturnValue({
      append: vi.fn(),
      type: 'paragraph-node',
    });
  });

  it('does nothing when payload or editor is missing', () => {
    const editor = createEditor();

    insertFileReferenceIntoEditor(editor, null);
    insertFileReferenceIntoEditor(null, payload);

    expect(editor.focus).not.toHaveBeenCalled();
    expect(editor.update).not.toHaveBeenCalled();
    expect(lexicalMocks.createFileReferenceNode).not.toHaveBeenCalled();
  });

  it('focuses the editor and inserts into an active range selection', () => {
    const editor = createEditor();
    const selection = {
      insertNodes: vi.fn(),
    };
    lexicalMocks.getSelection.mockReturnValue(selection);
    lexicalMocks.isRangeSelection.mockReturnValue(true);

    insertFileReferenceIntoEditor(editor, payload);

    expect(editor.focus).toHaveBeenCalledTimes(1);
    expect(editor.update).toHaveBeenCalledTimes(1);
    expect(lexicalMocks.createFileReferenceNode).toHaveBeenCalledWith(payload);
    expect(lexicalMocks.createTextNode).toHaveBeenCalledWith(' ');
    expect(selection.insertNodes).toHaveBeenCalledWith([
      { type: 'file-reference-node' },
      { type: 'space-node' },
    ]);
  });

  it('appends to the last element child when there is no range selection', () => {
    const editor = createEditor();
    const lastChild = { append: vi.fn() };
    lexicalMocks.getSelection.mockReturnValue(null);
    lexicalMocks.isRangeSelection.mockReturnValue(false);
    lexicalMocks.getRoot.mockReturnValue({
      getLastChild: () => lastChild,
    });
    lexicalMocks.isElementNode.mockReturnValue(true);

    insertFileReferenceIntoEditor(editor, payload);

    expect(lastChild.append).toHaveBeenCalledWith(
      { type: 'file-reference-node' },
      { type: 'space-node' }
    );
  });

  it('creates a paragraph when the root has no appendable last element', () => {
    const editor = createEditor();
    const paragraph = {
      append: vi.fn(),
    };
    const root = {
      getLastChild: () => null,
      append: vi.fn(),
    };
    lexicalMocks.getSelection.mockReturnValue(null);
    lexicalMocks.isRangeSelection.mockReturnValue(false);
    lexicalMocks.getRoot.mockReturnValue(root);
    lexicalMocks.isElementNode.mockReturnValue(false);
    lexicalMocks.createParagraphNode.mockReturnValue(paragraph);

    insertFileReferenceIntoEditor(editor, payload);

    expect(paragraph.append).toHaveBeenCalledWith(
      { type: 'file-reference-node' },
      { type: 'space-node' }
    );
    expect(root.append).toHaveBeenCalledWith(paragraph);
  });
});
