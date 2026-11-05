import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { $isCodeNode } from '@lexical/code';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { RichTextEditor, RichTextEditorToolbar } from '@astryxdesign/richtext';
import { MermaidDiagram } from '@/components/NormalizedConversation/MermaidDiagram';
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

type MermaidBlockTarget = {
  readonly key: string;
  readonly code: string;
  readonly host: HTMLElement;
};

function isMermaidLanguage(language: string | null | undefined): boolean {
  return (language ?? '').trim().toLowerCase() === 'mermaid';
}

function sameMermaidTargets(
  prev: ReadonlyArray<MermaidBlockTarget>,
  next: ReadonlyArray<MermaidBlockTarget>
): boolean {
  return (
    prev.length === next.length &&
    prev.every(
      (item, index) =>
        item.key === next[index]?.key &&
        item.code === next[index]?.code &&
        item.host === next[index]?.host
    )
  );
}

export function MarkdownMermaidPreviewPlugin() {
  const [editor] = useLexicalComposerContext();
  const [targets, setTargets] = useState<ReadonlyArray<MermaidBlockTarget>>([]);
  const hostsByElementRef = useRef<WeakMap<HTMLElement, HTMLElement>>(
    new WeakMap()
  );
  const mountedHostsRef = useRef<Set<HTMLElement>>(new Set());

  useEffect(() => {
    const hostsByElement = hostsByElementRef.current;
    const mountedHosts = mountedHostsRef.current;

    const syncMermaidBlocks = () => {
      const nextTargets: MermaidBlockTarget[] = [];
      const activeHosts = new Set<HTMLElement>();

      editor.getEditorState().read(() => {
        for (const node of $getRoot().getChildren()) {
          if (!$isCodeNode(node) || !isMermaidLanguage(node.getLanguage())) {
            continue;
          }
          const key = node.getKey();
          const element = editor.getElementByKey(key);
          if (!(element instanceof HTMLElement)) {
            continue;
          }
          const code = node.getTextContent().trim();
          if (!code) {
            continue;
          }
          let host = hostsByElement.get(element);
          if (!host) {
            host = document.createElement('div');
            host.className = 'markdown-rich-text-mermaid-preview';
            host.contentEditable = 'false';
            host.setAttribute('contenteditable', 'false');
            host.setAttribute('data-richtext-mermaid-preview', key);
            hostsByElement.set(element, host);
          }
          if (host.previousElementSibling !== element) {
            element.after(host);
          }
          mountedHosts.add(host);
          activeHosts.add(host);
          nextTargets.push({ key, code, host });
        }
      });

      for (const host of Array.from(mountedHosts)) {
        if (!activeHosts.has(host)) {
          host.remove();
          mountedHosts.delete(host);
        }
      }

      setTargets((current) =>
        sameMermaidTargets(current, nextTargets) ? current : nextTargets
      );
    };

    syncMermaidBlocks();
    const unregisterUpdate = editor.registerUpdateListener(() => {
      syncMermaidBlocks();
    });
    const unregisterRoot = editor.registerRootListener(() => {
      syncMermaidBlocks();
    });

    return () => {
      unregisterUpdate();
      unregisterRoot();
      for (const host of Array.from(mountedHosts)) {
        host.remove();
      }
      mountedHosts.clear();
    };
  }, [editor]);

  return (
    <>
      {targets.map((target) =>
        createPortal(
          <MermaidDiagram value={target.code} />,
          target.host,
          target.key
        )
      )}
    </>
  );
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

function MarkdownExternalSyncPlugin({
  markdown,
  lastMarkdownRef,
}: {
  markdown: string;
  lastMarkdownRef: MutableRefObject<string>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (markdown === lastMarkdownRef.current) {
      return;
    }
    lastMarkdownRef.current = markdown;
    try {
      const nextState = editor.parseEditorState(toEditorState(markdown));
      editor.setEditorState(nextState);
    } catch {
      // Ignore malformed external markdown updates.
    }
  }, [editor, lastMarkdownRef, markdown]);

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
  const lastMarkdownRef = useRef(markdown);
  const defaultValue = useRef(toEditorState(markdown)).current;

  const handleChange = useCallback(
    (_state: unknown, editor: LexicalEditor) => {
      const next = markdownFromEditor(editor);
      lastMarkdownRef.current = next;
      onMarkdownChange(next);
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
        plugins={
          <>
            <MarkdownImagePastePlugin pasteImages={pasteImages} />
            <MarkdownExternalSyncPlugin
              markdown={markdown}
              lastMarkdownRef={lastMarkdownRef}
            />
            <MarkdownMermaidPreviewPlugin />
          </>
        }
        onChange={handleChange}
      />
    </div>
  );
}

export default MarkdownRichTextEditor;
