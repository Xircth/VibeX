import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  type LexicalEditor,
} from 'lexical';
import type { FileReferencePayload } from '@/utils/fileReferences';

import { $createFileReferenceNode } from './nodes/file-reference-node';

export function insertFileReferenceIntoEditor(
  editor: LexicalEditor | null,
  payload: FileReferencePayload | null
) {
  if (!payload || !editor) {
    return;
  }

  editor.focus();
  editor.update(() => {
    const node = $createFileReferenceNode(payload);
    const spaceNode = $createTextNode(' ');
    const selection = $getSelection();

    if ($isRangeSelection(selection)) {
      selection.insertNodes([node, spaceNode]);
      return;
    }

    const root = $getRoot();
    const lastChild = root.getLastChild();

    if (lastChild && $isElementNode(lastChild)) {
      lastChild.append(node, spaceNode);
      return;
    }

    const paragraph = $createParagraphNode();
    paragraph.append(node, spaceNode);
    root.append(paragraph);
  });
}
