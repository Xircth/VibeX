import { useEffect, useCallback } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $isElementNode,
  $createTextNode,
  $getRoot,
} from 'lexical';
import { $createParagraphNode } from 'lexical';
import {
  $createClickedElementNode,
  type ClickedElementData,
} from '../nodes/clicked-element-node';

interface ClickedElementInsertPluginProps {
  onRegisterInsert: (insertFn: (data: ClickedElementData) => void) => void;
}

export function ClickedElementInsertPlugin({
  onRegisterInsert,
}: ClickedElementInsertPluginProps) {
  const [editor] = useLexicalComposerContext();

  const insertClickedElement = useCallback(
    (data: ClickedElementData) => {
      editor.update(() => {
        const node = $createClickedElementNode(data);
        const space = $createTextNode(' ');

        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertNodes([node, space]);
          return;
        }

        // No active selection (e.g., user clicked in preview panel, editor unfocused).
        // Append to the last element node, or create a new paragraph if root is empty.
        const root = $getRoot();
        const lastChild = root.getLastChild();

        if (lastChild && $isElementNode(lastChild)) {
          lastChild.append(node, space);
        } else {
          // Root is empty or last child is not an element — create a paragraph
          const paragraph = $createParagraphNode();
          paragraph.append(node, space);
          root.append(paragraph);
        }
      });
    },
    [editor]
  );

  useEffect(() => {
    onRegisterInsert(insertClickedElement);
  }, [onRegisterInsert, insertClickedElement]);

  return null;
}
