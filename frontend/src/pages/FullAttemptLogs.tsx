// VS Code webview integration - install keyboard/clipboard bridge
import '@/vscode/bridge';

import { useParams } from 'react-router-dom';
import { AppWithStyleOverride } from '@/utils/StyleOverride';
import { WebviewContextMenu } from '@/vscode/ContextMenu';
import { KanbanSessionConversationView } from '@/components/kanban/KanbanSessionConversationView';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import { ReviewProvider } from '@/contexts/ReviewProvider';
import { ClickedElementsProvider } from '@/contexts/ClickedElementsProvider';
import { Loader } from '@/components/ui/loader';

export function FullAttemptLogsPage() {
  const { attemptId = '' } = useParams<{
    projectId: string;
    attemptId: string;
  }>();

  const { data: attempt } = useTaskAttemptWithSession(attemptId);

  return (
    <AppWithStyleOverride>
      <div className="h-screen flex flex-col bg-muted">
        <WebviewContextMenu />

        <main className="flex-1 min-h-0">
          {attempt ? (
            <ClickedElementsProvider attempt={attempt}>
              <ReviewProvider key={attempt.id}>
                <KanbanSessionConversationView
                  workspaceId={attempt.id}
                  sessionId={attempt.session?.id ?? ''}
                  initialWorkspace={attempt}
                  initialSession={attempt.session}
                  interactive={true}
                  showSessionSelector={true}
                  className="h-full"
                />
              </ReviewProvider>
            </ClickedElementsProvider>
          ) : (
            <Loader message={'加载会话中...'} size={32} className="py-8" />
          )}
        </main>
      </div>
    </AppWithStyleOverride>
  );
}
