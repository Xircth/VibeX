import { useMemo, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import {
  useConversationSessionFacts,
  useConversationTimeline,
} from '@/features/conversation/useConversationTimeline';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import { requestConversationScrollToTurn } from '@/lib/conversationScroll';
import { useGitDiffNavigationStore } from '@/stores/useGitDiffNavigationStore';
import { SessionDetailsView } from './session-details/SessionDetailsView';
import { SessionQuota } from './session-details/SessionQuota';
import { buildSessionDetails } from './session-details/sessionDetailsModel';

export default function DockviewSessionDetailsPanel(
  _props: IDockviewPanelProps
) {
  const { activeWorktreeId } = useWorktree();
  const { visibleRightSession } = useKanbanSessionContext();
  const workspaceId =
    visibleRightSession?.workspaceId ?? activeWorktreeId ?? undefined;
  const { data: attempt } = useTaskAttemptWithSession(workspaceId);
  const sessionId =
    visibleRightSession?.sessionId ?? attempt?.session?.id ?? null;
  const conversation = useConversationTimeline(sessionId);
  const facts = useConversationSessionFacts(sessionId);
  const { openDiffPreview } = usePanelActionsContext();
  const focusDiffPath = useGitDiffNavigationStore((state) => state.focusPath);
  const branch = attempt?.branch?.trim() || null;
  const [quotaActive, setQuotaActive] = useState(false);

  const model = useMemo(
    () =>
      buildSessionDetails({
        facts,
        turns: conversation.timeline,
        sideRows: conversation.sideRows,
        branch,
        configOptions: conversation.sessionConfigOptions,
        currentTurnId: conversation.currentTurnId,
      }),
    [
      branch,
      conversation.currentTurnId,
      conversation.sessionConfigOptions,
      conversation.sideRows,
      conversation.timeline,
      facts,
    ]
  );

  return (
    <SessionDetailsView
      model={model}
      quota={<SessionQuota agentId={facts.agentId} onActive={setQuotaActive} />}
      quotaActive={quotaActive}
      onJumpToMessage={(turnId) => {
        if (!sessionId) return;
        requestConversationScrollToTurn(sessionId, turnId);
      }}
      onOpenFile={(path) => {
        openDiffPreview();
        focusDiffPath(path);
      }}
    />
  );
}
