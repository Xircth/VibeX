import { useRef, type MouseEvent } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Loader2, StickyNote } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useWorktree } from '@/contexts/WorktreeContext';
import { useWorkspaceNotes } from '@/hooks/useWorkspaceNotes';
import { useAppContextMenu } from '@/components/context-menu';
import { requestComposerInsert } from '@/lib/composerInsert';
import { writeClipboardViaBridge } from '@/vscode/bridge';

function DockviewNotesPanel(_props: IDockviewPanelProps) {
  const { t } = useTranslation('common');
  const { openSurfaceMenu } = useAppContextMenu();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const { activeWorktreeId } = useWorktree();
  const { content, setContent, isLoading } = useWorkspaceNotes(
    activeWorktreeId ?? undefined
  );

  const openNotesMenu = (event: MouseEvent, fromEditor: boolean) => {
    if (fromEditor) return;
    openSurfaceMenu(event, [
      {
        id: 'send-composer',
        label: t('contextMenu.sendToComposer'),
        disabled: !content.trim(),
        onSelect: () => {
          requestComposerInsert(content);
        },
      },
      {
        id: 'copy-note',
        label: t('contextMenu.copyNote'),
        onSelect: () => {
          void writeClipboardViaBridge(content);
        },
      },
      {
        id: 'jump-bottom',
        label: t('contextMenu.jumpToBottom'),
        onSelect: () => {
          const el = editorRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        },
      },
      {
        id: 'jump-top',
        label: t('contextMenu.jumpToTop'),
        onSelect: () => {
          const el = editorRef.current;
          if (el) el.scrollTop = 0;
        },
      },
    ]);
  };

  if (!activeWorktreeId) {
    return (
      <div
        className="h-full w-full overflow-auto bg-background p-3"
        data-panel="notes"
        onContextMenu={(event) => openNotesMenu(event, false)}
      >
        <div className="mb-3 flex items-center gap-2">
          <StickyNote className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Notes</span>
        </div>
        <div className="flex h-[calc(100%-2rem)] items-center justify-center text-sm text-muted-foreground">
          Select a workspace to edit notes.
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative h-full w-full overflow-auto bg-background p-3"
      data-panel="notes"
      onContextMenu={(event) => openNotesMenu(event, false)}
    >
      <div className="mb-3 flex items-center gap-2">
        <StickyNote className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Notes</span>
      </div>
      <textarea
        ref={editorRef}
        className="notes-editor h-[calc(100%-2rem)] w-full resize-none text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        placeholder={
          isLoading ? 'Loading notes...' : 'Write workspace notes here...'
        }
        value={isLoading ? '' : content}
        onChange={(event) => setContent(event.target.value)}
        disabled={isLoading}
      />
      {isLoading && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

export default DockviewNotesPanel;
