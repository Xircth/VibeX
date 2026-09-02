import { memo } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import { Unlink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SessionHubListItem } from '@/components/kanban/session-hub/SessionHubListItem';
import { CanvasNodeAnchors } from './CanvasNodeAnchors';
import { useSessionCanvasView } from './CanvasViewContext';

export interface SessionCanvasCardData {
  sessionId: string;
  instanceId?: string;
  unresolved?: boolean;
  [key: string]: unknown;
}

export type SessionCanvasCardFlowNode = Node<
  SessionCanvasCardData,
  'sessionCard'
>;

export const SessionCanvasCardNode = memo(function SessionCanvasCardNode({
  data,
  selected,
}: NodeProps<SessionCanvasCardFlowNode>) {
  const { t } = useTranslation(['tasks']);
  const {
    sessionsById,
    sessionsReady,
    removeCard,
    onRenameSession,
    onDeleteSession,
  } = useSessionCanvasView();
  const session = sessionsById.get(data.sessionId);

  if (!session) {
    if (!sessionsReady) {
      return (
        <div className="h-full w-full rounded-lg bg-[var(--surface-control)]" />
      );
    }
    return (
      <div className="canvas-board-units flex h-full w-full flex-col items-start justify-between overflow-hidden rounded-lg border border-dashed border-border bg-[var(--surface-card-strong)] px-3 py-2 opacity-70">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="text-xs">{t('hubCanvas.missingSession')}</span>
        </div>
        <button
          type="button"
          className="nodrag text-xs text-muted-foreground hover:text-destructive"
          onClick={() => removeCard(data.instanceId ?? data.sessionId)}
        >
          {t('hubCanvas.removeCard')}
        </button>
      </div>
    );
  }

  return (
    <div className="canvas-board-units canvas-session-card h-full w-full overflow-hidden rounded-lg">
      <CanvasNodeAnchors />
      <SessionHubListItem
        session={session}
        marker={null}
        isDeleteMode={false}
        isSelected={selected}
        displayMode="canvas"
        onClick={() => undefined}
        onToggleSelect={() => undefined}
        onRenameSession={
          onRenameSession ? (name) => onRenameSession(session, name) : undefined
        }
        onDeleteSession={
          onDeleteSession ? () => onDeleteSession(session) : undefined
        }
      />
    </div>
  );
});
