import {
  useEffect,
  type ComponentProps,
  type DragEventHandler,
  type MutableRefObject,
  type ReactElement,
} from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { TablePlugin } from '@lexical/react/LexicalTablePlugin';
import type { Transformer } from '@lexical/markdown';
import type { EditorState, LexicalEditor } from 'lexical';
import type { ExecutorProfileId, SendMessageShortcut } from 'shared/types';
import { cn } from '@/lib/utils';

import type { LocalImageMetadata } from './context/task-attempt-context';
import { WysiwygEditorContextProviders } from './editor-context-providers';
import type { WysiwygEditingPluginPolicy } from './editing-plugin-policy';
import type { ClickedElementData } from './nodes/clicked-element-node';
import { WysiwygEditablePlugins } from './editable-plugins';
import { WysiwygReadOnlyPlugins } from './read-only-plugins';
import { CodeHighlightPlugin } from './plugins/code-highlight-plugin';
import { MarkdownSyncPlugin } from './plugins/markdown-sync-plugin';
import { StaticToolbarPlugin } from './plugins/static-toolbar-plugin';
import { ToolbarPlugin } from './plugins/toolbar-plugin';

type WysiwygEditorShellProps = {
  fileReferenceDropZoneRef: MutableRefObject<HTMLDivElement | null>;
  editorInstanceRef: MutableRefObject<LexicalEditor | null>;
  isSessionInputMinimalPreset: boolean;
  initialConfig: ComponentProps<typeof LexicalComposer>['initialConfig'];
  value: string;
  onChange?: (state: string) => void;
  onEditorStateChange?: (state: EditorState) => void;
  editable: boolean;
  activeTransformers: Transformer[];
  shortcutTransformers: Transformer[];
  placeholderElement: ReactElement;
  className?: string;
  handleDragOver: DragEventHandler<HTMLDivElement>;
  handleDrop: DragEventHandler<HTMLDivElement>;
  enableFloatingToolbar: boolean;
  showStaticToolbar: boolean;
  saveStatus?: 'idle' | 'saved';
  editingPluginPolicy: WysiwygEditingPluginPolicy;
  repoIds?: string[];
  projectId?: string;
  executorProfile?: ExecutorProfileId | null;
  repoId?: string;
  onCmdEnter?: () => void;
  onShiftCmdEnter?: () => void;
  sendShortcut?: SendMessageShortcut;
  taskAttemptId?: string;
  taskId?: string;
  localImages?: LocalImageMetadata[];
  onRegisterClickedElementInsert?: (
    insertFn: (data: ClickedElementData) => void
  ) => void;
  findMatchingDiffPath?: (text: string) => string | null;
  onCodeClick?: (fullPath: string) => void;
};

function EditorRefPlugin({
  editorRef,
}: {
  editorRef: MutableRefObject<LexicalEditor | null>;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
  }, [editor, editorRef]);
  return null;
}

export function WysiwygEditorShell({
  fileReferenceDropZoneRef,
  editorInstanceRef,
  isSessionInputMinimalPreset,
  initialConfig,
  value,
  onChange,
  onEditorStateChange,
  editable,
  activeTransformers,
  shortcutTransformers,
  placeholderElement,
  className,
  handleDragOver,
  handleDrop,
  enableFloatingToolbar,
  showStaticToolbar,
  saveStatus,
  editingPluginPolicy,
  repoIds,
  projectId,
  executorProfile,
  repoId,
  onCmdEnter,
  onShiftCmdEnter,
  sendShortcut,
  taskAttemptId,
  taskId,
  localImages,
  onRegisterClickedElementInsert,
  findMatchingDiffPath,
  onCodeClick,
}: WysiwygEditorShellProps) {
  return (
    <div
      ref={fileReferenceDropZoneRef}
      className={cn(
        'relative wysiwyg text-base',
        isSessionInputMinimalPreset &&
          'text-[13px] leading-5 tracking-[0.005em] antialiased [text-rendering:optimizeLegibility]'
      )}
      data-testid="wysiwyg-drop-zone"
      data-file-reference-drop-zone
      data-typeahead-surface
    >
      <WysiwygEditorContextProviders
        taskAttemptId={taskAttemptId}
        taskId={taskId}
        localImages={localImages}
      >
        <LexicalComposer initialConfig={initialConfig}>
          <EditorRefPlugin editorRef={editorInstanceRef} />
          <MarkdownSyncPlugin
            value={value}
            onChange={onChange}
            onEditorStateChange={onEditorStateChange}
            editable={editable}
            transformers={activeTransformers}
          />
          {editable && enableFloatingToolbar && <ToolbarPlugin />}
          <div className="relative">
            <RichTextPlugin
              contentEditable={
                <ContentEditable
                  data-typeahead-surface="editor"
                  className={cn('outline-none', className)}
                  aria-label={editable ? 'Markdown editor' : 'Markdown content'}
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

          {editable && showStaticToolbar && (
            <StaticToolbarPlugin saveStatus={saveStatus} />
          )}

          <ListPlugin />
          <TablePlugin />
          <CodeHighlightPlugin />
          {editable && (
            <WysiwygEditablePlugins
              policy={editingPluginPolicy}
              activeTransformers={activeTransformers}
              shortcutTransformers={shortcutTransformers}
              repoIds={repoIds}
              projectId={projectId}
              executorProfile={executorProfile}
              repoId={repoId}
              onCmdEnter={onCmdEnter}
              onShiftCmdEnter={onShiftCmdEnter}
              onChange={onChange}
              sendShortcut={sendShortcut}
              onRegisterClickedElementInsert={onRegisterClickedElementInsert}
            />
          )}
          {!editable && (
            <WysiwygReadOnlyPlugins
              findMatchingDiffPath={findMatchingDiffPath}
              onCodeClick={onCodeClick}
            />
          )}
        </LexicalComposer>
      </WysiwygEditorContextProviders>
    </div>
  );
}
