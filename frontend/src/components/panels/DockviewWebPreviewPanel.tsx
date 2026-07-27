import { useCallback, useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import {
  ExecutionProcessesProvider,
  useExecutionProcessesContext,
} from '@/contexts/ExecutionProcessesContext';
import { useClickedElements } from '@/contexts/ClickedElementsProvider';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useRightPanelSlot } from '@/contexts/RightPanelSlotContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { BrowserPanel } from '@/features/browser/BrowserPanel';
import { useDevserverUrlFromLogs } from '@/hooks/useDevserverUrl';
import { useLogStream } from '@/hooks/useLogStream';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import type { WebPreviewPanelParams } from '@/types/panels';

interface WorkspaceBrowserPanelProps {
  api: IDockviewPanelProps['api'];
  layoutVersion: number;
  requestedUrl: string | null;
  requestedUrlNonce: number;
  visible: boolean;
  workspaceId?: string;
}

function WorkspaceBrowserPanel({
  api,
  layoutVersion,
  requestedUrl,
  requestedUrlNonce,
  visible,
  workspaceId,
}: WorkspaceBrowserPanelProps) {
  const { addElement } = useClickedElements();
  const { executionProcessesVisible } = useExecutionProcessesContext();
  const primaryDevServer = executionProcessesVisible
    .filter(
      (process) =>
        process.run_reason === 'devserver' && process.status === 'running'
    )
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
  const { logs } = useLogStream(primaryDevServer?.id ?? '');
  const detectedUrl = useDevserverUrlFromLogs(logs)?.url;
  const initialUrl = requestedUrl ?? detectedUrl ?? null;

  const updateTitle = useCallback(
    (title: string) => {
      if (title.trim()) api.setTitle(title);
    },
    [api]
  );

  return (
    <BrowserPanel
      initialUrl={initialUrl}
      requestNonce={requestedUrlNonce}
      workspaceId={workspaceId}
      visible={visible}
      layoutVersion={layoutVersion}
      onTitleChange={updateTitle}
      onInspectElement={addElement}
    />
  );
}

export default function DockviewWebPreviewPanel(props: IDockviewPanelProps) {
  const params = (props.params ?? {}) as Partial<WebPreviewPanelParams>;
  const { placement } = useRightPanelSlot();
  const { activeWorktreeId } = useWorktree();
  const { visibleRightSession } = useKanbanSessionContext();
  const workspaceId =
    visibleRightSession?.workspaceId ?? activeWorktreeId ?? undefined;
  const { data: attempt } = useTaskAttemptWithSession(workspaceId);
  const executionKey = `${workspaceId ?? 'none'}:${attempt?.session?.id ?? 'none'}`;
  const [layoutState, setLayoutState] = useState(() => ({
    version: 0,
    visible: props.api.isVisible,
  }));

  useEffect(() => {
    const syncLayout = (nextVisible = props.api.isVisible) => {
      setLayoutState((current) => ({
        version: current.version + 1,
        visible: nextVisible,
      }));
    };
    const visibility = props.api.onDidVisibilityChange((event) => {
      syncLayout(event.isVisible);
    });
    const dimensions = props.api.onDidDimensionsChange(() => syncLayout());
    const active = props.api.onDidActiveChange(() => syncLayout());

    return () => {
      visibility.dispose();
      dimensions.dispose();
      active.dispose();
    };
  }, [props.api]);

  return (
    <ExecutionProcessesProvider
      key={executionKey}
      attemptId={workspaceId}
      sessionId={attempt?.session?.id}
    >
      <WorkspaceBrowserPanel
        api={props.api}
        layoutVersion={layoutState.version}
        requestedUrl={params.requestedUrl ?? null}
        requestedUrlNonce={params.requestedUrlNonce ?? 0}
        visible={layoutState.visible && placement === 'workspace'}
        workspaceId={workspaceId}
      />
    </ExecutionProcessesProvider>
  );
}
