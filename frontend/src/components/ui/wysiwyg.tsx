import {
  useMemo,
  useCallback,
  memo,
  forwardRef,
  useImperativeHandle,
  useRef,
} from 'react';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import {
  type ClickedElementData,
} from './wysiwyg/nodes/clicked-element-node';
import type { LocalImageMetadata } from './wysiwyg/context/task-attempt-context';
import {
  getWysiwygMarkdownShortcutTransformers,
  getWysiwygMarkdownTransformers,
} from './wysiwyg/wysiwyg-markdown-policy';
import { WysiwygReadOnlyActions } from './wysiwyg/read-only-actions';
import { EditorState, type LexicalEditor } from 'lexical';
import { cn } from '@/lib/utils';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import {
  type ExecutorProfileId,
  type SendMessageShortcut,
} from 'shared/types';
import type { FileReferencePayload } from '@/utils/fileReferences';
import { getWysiwygEditingPluginPolicy } from './wysiwyg/editing-plugin-policy';
import { getWysiwygInitialConfig } from './wysiwyg/editor-config-policy';
import { insertFileReferenceIntoEditor } from './wysiwyg/file-reference-insertion';
import { useFileReferenceDropHandlers } from './wysiwyg/use-file-reference-drop-handlers';
import { WysiwygEditorShell } from './wysiwyg/editor-shell';

/** Markdown string representing the editor content */
export type SerializedEditorState = string;
export type WysiwygMarkdownPreset = 'default' | 'session-input-minimal';
export const SESSION_INPUT_MARKDOWN_PRESET: WysiwygMarkdownPreset =
  'session-input-minimal';
export const SESSION_INPUT_TEXT_CLASS_NAME =
  'break-words overflow-wrap-anywhere text-[13px] leading-5 tracking-[0.005em]';
export const SESSION_INPUT_EDITOR_CLASS_NAME = `min-h-[40px] max-h-[100px] overflow-y-auto ${SESSION_INPUT_TEXT_CLASS_NAME}`;

type WysiwygProps = {
  placeholder?: string;
  /** Markdown string representing the editor content */
  value: SerializedEditorState;
  onChange?: (state: SerializedEditorState) => void;
  onEditorStateChange?: (s: EditorState) => void;
  disabled?: boolean;
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

const WYSIWYGEditor = forwardRef<WYSIWYGEditorRef, WysiwygProps>(
  function WYSIWYGEditor(
    {
      placeholder = '',
      value,
      onChange,
      onEditorStateChange,
      disabled = false,
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
      (payload: FileReferencePayload | null) => {
        insertFileReferenceIntoEditor(editorInstanceRef.current, payload);
      },
      []
    );

    const initialConfig = useMemo(
      () => getWysiwygInitialConfig(markdownPreset),
      [markdownPreset]
    );

    const activeTransformers = useMemo(
      () => getWysiwygMarkdownTransformers(markdownPreset),
      [markdownPreset]
    );

    const shortcutTransformers = useMemo(
      () => getWysiwygMarkdownShortcutTransformers(markdownPreset),
      [markdownPreset]
    );

    const editingPluginPolicy = useMemo(
      () =>
        getWysiwygEditingPluginPolicy({
          disabled,
          markdownPreset,
          autoFocus,
          executorProfile,
          hasClickedElementInsert: Boolean(onRegisterClickedElementInsert),
        }),
      [
        autoFocus,
        disabled,
        executorProfile,
        markdownPreset,
        onRegisterClickedElementInsert,
      ]
    );

    const { fileReferenceDropZoneRef, handleDragOver, handleDrop } =
      useFileReferenceDropHandlers({
        disabled,
        onInsertFileReference: insertFileReference,
      });

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
      <WysiwygEditorShell
        fileReferenceDropZoneRef={fileReferenceDropZoneRef}
        editorInstanceRef={editorInstanceRef}
        isSessionInputMinimalPreset={isSessionInputMinimalPreset}
        initialConfig={initialConfig}
        value={value}
        onChange={onChange}
        onEditorStateChange={onEditorStateChange}
        editable={!disabled}
        activeTransformers={activeTransformers}
        shortcutTransformers={shortcutTransformers}
        placeholderElement={placeholderElement}
        className={className}
        handleDragOver={handleDragOver}
        handleDrop={handleDrop}
        enableFloatingToolbar={enableFloatingToolbar}
        showStaticToolbar={showStaticToolbar}
        saveStatus={saveStatus}
        editingPluginPolicy={editingPluginPolicy}
        repoIds={repoIds}
        projectId={projectId}
        executorProfile={executorProfile}
        repoId={repoId}
        onCmdEnter={onCmdEnter}
        onShiftCmdEnter={onShiftCmdEnter}
        sendShortcut={sendShortcut}
        taskAttemptId={taskAttemptId}
        taskId={taskId}
        localImages={localImages}
        onRegisterClickedElementInsert={onRegisterClickedElementInsert}
        findMatchingDiffPath={findMatchingDiffPath}
        onCodeClick={onCodeClick}
      />
    );

    // Wrap with action buttons in read-only mode
    if (disabled) {
      return (
        <div className="group">
          {editorContent}
          {!hideReadOnlyActions && (
            <WysiwygReadOnlyActions
              copied={copied}
              onCopy={handleCopy}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          )}
        </div>
      );
    }

    return editorContent;
  }
);

export default memo(WYSIWYGEditor);
