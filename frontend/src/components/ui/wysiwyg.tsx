import {
  useMemo,
  useCallback,
  memo,
  forwardRef,
  useImperativeHandle,
  useRef,
  useEffect,
} from 'react';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import {
  TRANSFORMERS,
  CODE,
  HEADING,
  ORDERED_LIST,
  UNORDERED_LIST,
  type Transformer,
} from '@lexical/markdown';
import { ImageNode, IMAGE_TRANSFORMER } from './wysiwyg/nodes/image-node';
import {
  PrCommentNode,
  PR_COMMENT_TRANSFORMER,
  PR_COMMENT_EXPORT_TRANSFORMER,
} from './wysiwyg/nodes/pr-comment-node';
import { TABLE_TRANSFORMER } from './wysiwyg/transformers/table-transformer';
import {
  TagReferenceNode,
  TAG_REFERENCE_TRANSFORMER,
} from './wysiwyg/nodes/tag-reference-node';
import {
  SlashCommandNode,
  SLASH_COMMAND_TRANSFORMER,
} from './wysiwyg/nodes/slash-command-node';
import {
  DollarCommandNode,
  DOLLAR_COMMAND_TRANSFORMER,
} from './wysiwyg/nodes/dollar-command-node';
import {
  FileReferenceNode,
  FILE_REFERENCE_TRANSFORMER,
  $createFileReferenceNode,
} from './wysiwyg/nodes/file-reference-node';
import {
  ClickedElementNode,
  CLICKED_ELEMENT_TRANSFORMER,
  type ClickedElementData,
} from './wysiwyg/nodes/clicked-element-node';
import { ClickedElementInsertPlugin } from './wysiwyg/plugins/clicked-element-insert-plugin';
import {
  TaskAttemptContext,
  TaskContext,
  LocalImagesContext,
  type LocalImageMetadata,
} from './wysiwyg/context/task-attempt-context';
import { TypeaheadOpenProvider } from './wysiwyg/context/typeahead-open-context';
import { FileTagTypeaheadPlugin } from './wysiwyg/plugins/file-tag-typeahead-plugin';
import { SlashCommandTypeaheadPlugin } from './wysiwyg/plugins/slash-command-typeahead-plugin';
import { DollarCommandTypeaheadPlugin } from './wysiwyg/plugins/dollar-command-typeahead-plugin';
import { KeyboardCommandsPlugin } from './wysiwyg/plugins/keyboard-commands-plugin';
import { ImageKeyboardPlugin } from './wysiwyg/plugins/image-keyboard-plugin';
import { ReadOnlyLinkPlugin } from './wysiwyg/plugins/read-only-link-plugin';
import { ClickableCodePlugin } from './wysiwyg/plugins/clickable-code-plugin';
import { ToolbarPlugin } from './wysiwyg/plugins/toolbar-plugin';
import { StaticToolbarPlugin } from './wysiwyg/plugins/static-toolbar-plugin';
import { CodeBlockShortcutPlugin } from './wysiwyg/plugins/code-block-shortcut-plugin';
import { PasteMarkdownPlugin } from './wysiwyg/plugins/paste-markdown-plugin';
import { MarkdownSyncPlugin } from './wysiwyg/plugins/markdown-sync-plugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListNode, ListItemNode } from '@lexical/list';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { CodeHighlightPlugin } from './wysiwyg/plugins/code-highlight-plugin';
import { CODE_HIGHLIGHT_CLASSES } from './wysiwyg/lib/code-highlight-theme';
import { LinkNode } from '@lexical/link';
import { TableNode, TableRowNode, TableCellNode } from '@lexical/table';
import { TablePlugin } from '@lexical/react/LexicalTablePlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  EditorState,
  type LexicalEditor,
} from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { cn } from '@/lib/utils';
import { extractImageFilesFromClipboardData } from '@/utils/clipboard';
import {
  FILE_REFERENCE_DRAG_MIME,
  parseFileReferencePayload,
} from '@/utils/fileReferences';
import {
  clearCurrentDraggedFileReference,
  getCurrentDraggedFileReference,
} from '@/utils/fileReferenceDrag';
import { Check, Clipboard, Pencil, Trash2 } from 'lucide-react';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import {
  BaseCodingAgent,
  type ExecutorProfileId,
  type SendMessageShortcut,
} from 'shared/types';
import type { FileReferencePayload } from '@/utils/fileReferences';

/** Markdown string representing the editor content */
export type SerializedEditorState = string;
export type WysiwygMarkdownPreset = 'default' | 'session-input-minimal';
export const SESSION_INPUT_MARKDOWN_PRESET: WysiwygMarkdownPreset =
  'session-input-minimal';
export const SESSION_INPUT_TEXT_CLASS_NAME =
  'break-words overflow-wrap-anywhere text-[13px] leading-5 tracking-[0.005em]';
export const SESSION_INPUT_EDITOR_CLASS_NAME = `min-h-[40px] ${SESSION_INPUT_TEXT_CLASS_NAME}`;

type WysiwygProps = {
  placeholder?: string;
  /** Markdown string representing the editor content */
  value: SerializedEditorState;
  onChange?: (state: SerializedEditorState) => void;
  onEditorStateChange?: (s: EditorState) => void;
  disabled?: boolean;
  onPasteFiles?: (files: File[]) => void;
  className?: string;
  /** Repo IDs for file search in typeahead (preferred over projectId) */
  repoIds?: string[];
  /** Project ID for file search in typeahead (fallback if repoIds not provided) */
  projectId?: string;
  /** Enables `/` command autocomplete (profile-aware). */
  executorProfile?: ExecutorProfileId | null;
  onCmdEnter?: () => void;
  onShiftCmdEnter?: () => void;
  /** Keyboard shortcut mode for sending messages */
  sendShortcut?: SendMessageShortcut;
  /** Task attempt ID for resolving .vibe-images paths (preferred over taskId) */
  taskAttemptId?: string;
  /** Task ID for resolving .vibe-images paths when taskAttemptId is not available */
  taskId?: string;
  /** Repo ID for slash commands when no workspace yet */
  repoId?: string;
  /** Local images for immediate rendering (before saved to server) */
  localImages?: LocalImageMetadata[];
  /** Optional edit callback - shows edit button in read-only mode when provided */
  onEdit?: () => void;
  /** Optional delete callback - shows delete button in read-only mode when provided */
  onDelete?: () => void;
  /** Hide the default read-only action row */
  hideReadOnlyActions?: boolean;
  /** Auto-focus the editor on mount */
  autoFocus?: boolean;
  /** Function to find a matching diff path for clickable inline code (only in read-only mode) */
  findMatchingDiffPath?: (text: string) => string | null;
  /** Callback when clickable inline code is clicked (only in read-only mode) */
  onCodeClick?: (fullPath: string) => void;
  /** Show a static toolbar below the editor content */
  showStaticToolbar?: boolean;
  /** Save status indicator for static toolbar */
  saveStatus?: 'idle' | 'saved';
  /** Register a function that can insert clicked element chips into the editor */
  onRegisterClickedElementInsert?: (
    insertFn: (data: ClickedElementData) => void
  ) => void;
  /** Whether to enable the floating selection toolbar */
  enableFloatingToolbar?: boolean;
  /** Local markdown/render preset for editable composer variants */
  markdownPreset?: WysiwygMarkdownPreset;
};

/** Ref interface for WYSIWYGEditor, exposing imperative methods */
export interface WYSIWYGEditorRef {
  /** Focus the editor */
  focus: () => void;
}

/** Plugin to capture the Lexical editor instance into a ref */
function EditorRefPlugin({
  editorRef,
}: {
  editorRef: React.MutableRefObject<LexicalEditor | null>;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
  }, [editor, editorRef]);
  return null;
}

const WYSIWYGEditor = forwardRef<WYSIWYGEditorRef, WysiwygProps>(
  function WYSIWYGEditor(
    {
      placeholder = '',
      value,
      onChange,
      onEditorStateChange,
      disabled = false,
      onPasteFiles,
      className,
      repoIds,
      projectId,
      executorProfile = null,
      onCmdEnter,
      onShiftCmdEnter,
      sendShortcut,
      taskAttemptId,
      taskId,
      repoId,
      localImages,
      onEdit,
      onDelete,
      hideReadOnlyActions = false,
      autoFocus = false,
      findMatchingDiffPath,
      onCodeClick,
      showStaticToolbar = false,
      saveStatus,
      onRegisterClickedElementInsert,
      enableFloatingToolbar = true,
      markdownPreset = 'default',
    }: WysiwygProps,
    ref: React.ForwardedRef<WYSIWYGEditorRef>
  ) {
    const isSessionInputMinimalPreset =
      markdownPreset === 'session-input-minimal';

    // Ref to capture the Lexical editor instance for imperative methods
    const editorInstanceRef = useRef<LexicalEditor | null>(null);
    const fileReferenceDropZoneRef = useRef<HTMLDivElement | null>(null);

    // Expose focus method via ref
    useImperativeHandle(ref, () => ({
      focus: () => {
        editorInstanceRef.current?.focus();
      },
    }));

    // Copy button state
    const [copied, triggerCopied] = useTemporaryFlag(400);
    const handleCopy = useCallback(async () => {
      if (!value) return;
      try {
        // Unescape markdown-escaped underscores for cleaner clipboard output
        const unescaped = value.replace(/\\_/g, '_');
        await writeClipboardViaBridge(unescaped);
        triggerCopied();
      } catch {
        // noop – bridge handles fallback
      }
    }, [value, triggerCopied]);

    const insertFileReference = useCallback(
      (payload: ReturnType<typeof parseFileReferencePayload>) => {
        if (!payload || !editorInstanceRef.current) {
          return;
        }

        editorInstanceRef.current.focus();
        editorInstanceRef.current.update(() => {
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
      },
      []
    );

    const initialConfig = useMemo(
      () => ({
        namespace: 'md-wysiwyg',
        onError: console.error,
        theme: {
          paragraph: isSessionInputMinimalPreset
            ? 'mb-1 last:mb-0 text-[13px] font-normal leading-5 tracking-[0.005em] text-foreground'
            : 'mb-2 last:mb-0',
          heading: {
            h1: isSessionInputMinimalPreset
              ? 'mt-2 mb-1.5 text-[1.05rem] font-semibold leading-7 tracking-[0.01em] text-foreground'
              : 'mt-4 mb-2 text-2xl font-semibold',
            h2: isSessionInputMinimalPreset
              ? 'mt-2 mb-1.5 text-[1rem] font-semibold leading-7 tracking-[0.01em] text-foreground'
              : 'mt-3 mb-2 text-xl font-semibold',
            h3: isSessionInputMinimalPreset
              ? 'mt-2 mb-1 text-[0.95rem] font-semibold leading-7 tracking-[0.01em] text-foreground'
              : 'mt-3 mb-2 text-lg font-semibold',
            h4: isSessionInputMinimalPreset
              ? 'mt-1.5 mb-1 text-sm font-semibold leading-6 tracking-[0.03em] text-muted-foreground uppercase'
              : 'mt-2 mb-1 text-base font-medium',
            h5: isSessionInputMinimalPreset
              ? 'mt-1.5 mb-1 text-xs font-semibold leading-6 tracking-[0.05em] text-muted-foreground uppercase'
              : 'mt-2 mb-1 text-sm font-medium',
            h6: isSessionInputMinimalPreset
              ? 'mt-1.5 mb-1 text-[11px] font-semibold leading-5 tracking-[0.08em] text-muted-foreground uppercase'
              : 'mt-2 mb-1 text-xs font-medium uppercase tracking-wide',
          },
          quote:
            'my-3 border-l-4 border-primary-foreground pl-4 text-muted-foreground',
          list: {
            ul: isSessionInputMinimalPreset
              ? 'my-1 list-disc pl-5 text-[13px] leading-5 tracking-[0.005em]'
              : 'my-1 list-disc list-inside',
            ol: isSessionInputMinimalPreset
              ? 'my-1 list-decimal pl-5 text-[13px] leading-5 tracking-[0.005em]'
              : 'my-1 list-decimal list-inside',
            listitem: '',
            nested: {
              // Hide the structural wrapper marker Lexical adds for nested items.
              listitem: isSessionInputMinimalPreset
                ? 'list-none pl-3'
                : 'list-none pl-4',
            },
          },
          link: 'text-blue-600 dark:text-blue-400 underline underline-offset-2 cursor-pointer hover:text-blue-800 dark:hover:text-blue-300',
          text: {
            bold: isSessionInputMinimalPreset ? '' : 'font-semibold',
            italic: isSessionInputMinimalPreset ? '' : 'italic',
            underline: isSessionInputMinimalPreset
              ? ''
              : 'underline underline-offset-2',
            strikethrough: isSessionInputMinimalPreset ? '' : 'line-through',
            code: isSessionInputMinimalPreset
              ? ''
              : 'font-mono bg-muted bg-panel px-1 py-0.5 rounded',
          },
          code: 'block font-mono bg-secondary rounded-md px-3 py-2 my-2 whitespace-pre overflow-x-auto',
          codeHighlight: CODE_HIGHLIGHT_CLASSES,
          table: 'border-collapse my-2 w-full text-sm',
          tableRow: '',
          tableCell: 'border border-border px-3 py-2 text-left align-top',
          tableCellHeader:
            'bg-muted font-semibold border border-border px-3 py-2 text-left align-top',
        },
        nodes: [
          HeadingNode,
          QuoteNode,
          ListNode,
          ListItemNode,
          CodeNode,
          CodeHighlightNode,
          LinkNode,
          ImageNode,
          PrCommentNode,
          TagReferenceNode,
          SlashCommandNode,
          DollarCommandNode,
          FileReferenceNode,
          ClickedElementNode,
          TableNode,
          TableRowNode,
          TableCellNode,
        ],
      }),
      [isSessionInputMinimalPreset]
    );

    // Extended transformers with image, PR comment, and code block support (memoized to prevent unnecessary re-renders)
    const fullTransformers: Transformer[] = useMemo(
      () => [
        TABLE_TRANSFORMER,
        IMAGE_TRANSFORMER,
        PR_COMMENT_EXPORT_TRANSFORMER, // Export transformer for DecoratorNode (must be before import transformer)
        PR_COMMENT_TRANSFORMER, // Import transformer for fenced code block
        TAG_REFERENCE_TRANSFORMER, // Export-only transformer for tag reference chips
        SLASH_COMMAND_TRANSFORMER, // Export-only transformer for slash command chips
        DOLLAR_COMMAND_TRANSFORMER, // Export-only transformer for $ workflow command chips
        FILE_REFERENCE_TRANSFORMER, // Export-only transformer for dragged file reference chips
        CLICKED_ELEMENT_TRANSFORMER, // Export-only transformer for clicked element chips
        CODE,
        ...TRANSFORMERS,
      ],
      []
    );

    const sessionInputMinimalTransformers: Transformer[] = useMemo(
      () => [
        IMAGE_TRANSFORMER,
        TAG_REFERENCE_TRANSFORMER,
        SLASH_COMMAND_TRANSFORMER,
        DOLLAR_COMMAND_TRANSFORMER,
        FILE_REFERENCE_TRANSFORMER,
        CLICKED_ELEMENT_TRANSFORMER,
        HEADING,
        UNORDERED_LIST,
        ORDERED_LIST,
      ],
      []
    );

    const activeTransformers = useMemo(
      () =>
        isSessionInputMinimalPreset
          ? sessionInputMinimalTransformers
          : fullTransformers,
      [
        fullTransformers,
        isSessionInputMinimalPreset,
        sessionInputMinimalTransformers,
      ]
    );

    // Default mode keeps # for tag references; the session-input minimal preset
    // re-enables heading shortcuts because #<space> does not collide with #tag.
    const shortcutTransformers: Transformer[] = useMemo(
      () =>
        isSessionInputMinimalPreset
          ? activeTransformers
          : activeTransformers.filter((t) => t !== HEADING),
      [activeTransformers, isSessionInputMinimalPreset]
    );

    // Memoized handlers for ContentEditable to prevent re-renders
    const handlePaste = useCallback(
      (event: React.ClipboardEvent) => {
        if (!onPasteFiles || disabled) return;

        const files = extractImageFilesFromClipboardData(event.clipboardData);

        if (files.length > 0) {
          event.preventDefault();
          onPasteFiles(files);
        }
      },
      [onPasteFiles, disabled]
    );

    const handleDragOver = useCallback(
      (event: React.DragEvent) => {
        event.stopPropagation();
        if (disabled) {
          return;
        }

        if (
          Array.from(event.dataTransfer.types).includes(
            FILE_REFERENCE_DRAG_MIME
          ) ||
          getCurrentDraggedFileReference()
        ) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      },
      [disabled]
    );

    const handleDrop = useCallback(
      (event: React.DragEvent) => {
        event.stopPropagation();
        if (disabled) {
          return;
        }

        const payload =
          parseFileReferencePayload(
            event.dataTransfer.getData(FILE_REFERENCE_DRAG_MIME)
          ) ?? getCurrentDraggedFileReference();
        if (!payload) {
          return;
        }

        event.preventDefault();
        insertFileReference(payload);
        clearCurrentDraggedFileReference();
      },
      [disabled, insertFileReference]
    );

    useEffect(() => {
      const dropZone = fileReferenceDropZoneRef.current;
      if (!dropZone) {
        return;
      }

      const handleCustomDrop = (event: Event) => {
        const customEvent = event as CustomEvent<FileReferencePayload>;
        if (disabled) {
          return;
        }

        insertFileReference(customEvent.detail);
        clearCurrentDraggedFileReference();
      };

      dropZone.addEventListener(
        'vibe-file-reference-drop',
        handleCustomDrop as EventListener
      );

      return () => {
        dropZone.removeEventListener(
          'vibe-file-reference-drop',
          handleCustomDrop as EventListener
        );
      };
    }, [disabled, insertFileReference]);

    // Memoized placeholder element
    const placeholderElement = useMemo(
      () => (
        <div
          className={cn(
            'absolute top-0 left-0 text-base text-secondary-foreground text-low pointer-events-none truncate',
            className
          )}
        >
          {placeholder}
        </div>
      ),
      [placeholder, className]
    );

    const editorContent = (
      <div
        ref={fileReferenceDropZoneRef}
        className={cn(
          'relative wysiwyg text-base',
          isSessionInputMinimalPreset &&
            'text-[13px] leading-5 tracking-[0.005em] antialiased [text-rendering:optimizeLegibility]'
        )}
        data-file-reference-drop-zone
        data-typeahead-surface
      >
        <TaskAttemptContext.Provider value={taskAttemptId}>
          <TaskContext.Provider value={taskId}>
            <LocalImagesContext.Provider value={localImages ?? []}>
              <LexicalComposer initialConfig={initialConfig}>
                <EditorRefPlugin editorRef={editorInstanceRef} />
                <MarkdownSyncPlugin
                  value={value}
                  onChange={onChange}
                  onEditorStateChange={onEditorStateChange}
                  editable={!disabled}
                  transformers={activeTransformers}
                />
                {!disabled && enableFloatingToolbar && <ToolbarPlugin />}
                <div className="relative">
                  <RichTextPlugin
                    contentEditable={
                      <ContentEditable
                        data-typeahead-surface="editor"
                        className={cn('outline-none', className)}
                        aria-label={
                          disabled ? 'Markdown content' : 'Markdown editor'
                        }
                        onPaste={handlePaste}
                        onDragStartCapture={(event) => event.stopPropagation()}
                        onDragEnterCapture={(event) => event.stopPropagation()}
                        onDragOverCapture={(event) => event.stopPropagation()}
                        onDragLeaveCapture={(event) => event.stopPropagation()}
                        onDropCapture={(event) => event.stopPropagation()}
                        onDragOver={handleDragOver}
                        onDrop={handleDrop}
                      />
                    }
                    placeholder={placeholderElement}
                    ErrorBoundary={LexicalErrorBoundary}
                  />
                </div>

                {!disabled && showStaticToolbar && (
                  <StaticToolbarPlugin saveStatus={saveStatus} />
                )}

                <ListPlugin />
                <TablePlugin />
                <CodeHighlightPlugin />
                {/* Only include editing plugins when not in read-only mode */}
                {!disabled && (
                  <>
                    {autoFocus && <AutoFocusPlugin />}
                    <HistoryPlugin />
                    <MarkdownShortcutPlugin
                      transformers={shortcutTransformers}
                    />
                    <PasteMarkdownPlugin
                      transformers={activeTransformers}
                      allowRichHtmlPaste={!isSessionInputMinimalPreset}
                    />
                    <TypeaheadOpenProvider>
                      <FileTagTypeaheadPlugin
                        trigger="#"
                        projectId={projectId}
                      />
                      <FileTagTypeaheadPlugin
                        trigger="@"
                        repoIds={repoIds}
                        projectId={projectId}
                      />
                      {executorProfile && (
                        <SlashCommandTypeaheadPlugin
                          executorProfile={executorProfile}
                          repoId={repoId}
                        />
                      )}
                      {executorProfile?.executor === BaseCodingAgent.CODEX && (
                        <DollarCommandTypeaheadPlugin />
                      )}
                      <KeyboardCommandsPlugin
                        onCmdEnter={onCmdEnter}
                        onShiftCmdEnter={onShiftCmdEnter}
                        onChange={onChange}
                        transformers={activeTransformers}
                        sendShortcut={sendShortcut}
                      />
                    </TypeaheadOpenProvider>
                    <ImageKeyboardPlugin />
                    {!isSessionInputMinimalPreset && (
                      <CodeBlockShortcutPlugin />
                    )}
                    {onRegisterClickedElementInsert && (
                      <ClickedElementInsertPlugin
                        onRegisterInsert={onRegisterClickedElementInsert}
                      />
                    )}
                  </>
                )}
                {/* Link sanitization for read-only mode */}
                {disabled && <ReadOnlyLinkPlugin />}
                {/* Clickable code for file paths in read-only mode */}
                {disabled && findMatchingDiffPath && onCodeClick && (
                  <ClickableCodePlugin
                    findMatchingDiffPath={findMatchingDiffPath}
                    onCodeClick={onCodeClick}
                  />
                )}
              </LexicalComposer>
            </LocalImagesContext.Provider>
          </TaskContext.Provider>
        </TaskAttemptContext.Provider>
      </div>
    );

    // Wrap with action buttons in read-only mode
    if (disabled) {
      return (
        <div className="group">
          {editorContent}
          {!hideReadOnlyActions && (
            <div className="flex justify-end gap-0.5 mt-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
              {/* Copy button */}
              <button
                type="button"
                aria-label={copied ? 'Copied!' : 'Copy as Markdown'}
                title={copied ? 'Copied!' : 'Copy as Markdown'}
                onClick={handleCopy}
                className="p-1 rounded hover:bg-white/10 transition-colors"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-green-400" />
                ) : (
                  <Clipboard className="w-3.5 h-3.5 opacity-60 hover:opacity-100" />
                )}
              </button>
              {/* Edit button - only if onEdit provided */}
              {onEdit && (
                <button
                  type="button"
                  aria-label="Edit"
                  title="Edit"
                  onClick={onEdit}
                  className="p-1 rounded hover:bg-white/10 transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5 opacity-60 hover:opacity-100" />
                </button>
              )}
              {/* Delete button - only if onDelete provided */}
              {onDelete && (
                <button
                  type="button"
                  aria-label="Delete"
                  title="Delete"
                  onClick={onDelete}
                  className="p-1 rounded hover:bg-white/10 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5 opacity-60 hover:opacity-100" />
                </button>
              )}
            </div>
          )}
        </div>
      );
    }

    return editorContent;
  }
);

export default memo(WYSIWYGEditor);
