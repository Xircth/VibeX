import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { RichTextEditor, RichTextEditorToolbar } from '@astryxdesign/richtext';
import { extractImageFilesFromClipboardData } from '@/utils/clipboard';
import {
  markdownToRichTextState,
  richTextStateToMarkdown,
} from '@/utils/markdownRichTextState';
import './markdownRichTextEditor.css';

export type MarkdownRichTextEditorProps = {
  markdown: string;
  label: string;
  workspacePath: string | null;
  onMarkdownChange: (markdown: string) => void;
  onSave: () => void;
  pasteImages?: (files: File[]) => Promise<string[]>;
};

function toEditorState(markdown: string): string {
  try {
    return markdownToRichTextState(markdown);
  } catch {
    return markdownToRichTextState('');
  }
}

function markdownFromEditor(editor: LexicalEditor): string {
  try {
    return richTextStateToMarkdown(
      JSON.stringify(editor.getEditorState().toJSON())
    );
  } catch {
    return '';
  }
}

function MarkdownImagePastePlugin({
  pasteImages,
}: {
  pasteImages?: (files: File[]) => Promise<string[]>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!pasteImages) {
      return undefined;
    }

    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!(event instanceof ClipboardEvent)) {
          return false;
        }
        const files = extractImageFilesFromClipboardData(event.clipboardData);
        if (files.length === 0) {
          return false;
        }
        event.preventDefault();
        void (async () => {
          const insertions = await pasteImages(files);
          if (insertions.length === 0) {
            return;
          }
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.insertText(insertions.join('\n'));
            }
          });
        })();
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );
  }, [editor, pasteImages]);

  return null;
}

export function MarkdownRichTextEditor({
  markdown,
  label,
  workspacePath,
  onMarkdownChange,
  onSave,
  pasteImages,
}: MarkdownRichTextEditorProps) {
  const defaultValue = useRef(toEditorState(markdown)).current;

  const handleChange = useCallback(
    (_state: unknown, editor: LexicalEditor) => {
      onMarkdownChange(markdownFromEditor(editor));
    },
    [onMarkdownChange]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        onSave();
      }
    },
    [onSave]
  );

  return (
    <div
      className="markdown-rich-text-editor conv-markdown markdown-file-prose"
      data-testid="astryx-rich-text-editor"
      data-workspace-path={workspacePath ?? ''}
      onKeyDown={handleKeyDown}
    >
      <RichTextEditor
        label={label}
        isLabelHidden
        defaultValue={defaultValue}
        width="100%"
        size="md"
        tabEscapeHint=""
        toolbar={<RichTextEditorToolbar />}
        plugins={<MarkdownImagePastePlugin pasteImages={pasteImages} />}
        onChange={handleChange}
      />
    </div>
  );
}

export default MarkdownRichTextEditor;
