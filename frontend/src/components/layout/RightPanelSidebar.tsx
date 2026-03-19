import { useState, useCallback } from 'react';
import {
  Terminal,
  List,
  GitCompareArrows,
  StickyNote,
  Play,
  Globe,
  Loader2,
} from 'lucide-react';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { ViewProcessesDialog } from '@/components/dialogs/tasks/ViewProcessesDialog';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import { useAiHostedDevServerStart } from '@/hooks/useAiHostedDevServerStart';
import { attemptsApi, repoApi } from '@/lib/api';
import type { UpdateRepo } from 'shared/types';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export function RightPanelSidebar() {
  const { openNewTerminal, openDiffPreview, openNotes, openOrFocusPanel } =
    usePanelActionsContext();
  const { activeWorktreeId } = useWorktree();
  const { visibleRightSession } = useKanbanSessionContext();
  const effectiveWorkspaceId =
    activeWorktreeId ?? visibleRightSession?.workspaceId ?? undefined;
  const effectiveSessionId = visibleRightSession?.sessionId;
  const { data: attempt } = useTaskAttemptWithSession(effectiveWorkspaceId);
  const aiHostedDevStart = useAiHostedDevServerStart(effectiveWorkspaceId);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [showStartErrorDialog, setShowStartErrorDialog] = useState(false);
  const [showDevConfig, setShowDevConfig] = useState(false);
  const [devCommand, setDevCommand] = useState('');

  const handleStartDevServer = useCallback(async () => {
    if (!effectiveWorkspaceId || isStarting || aiHostedDevStart.isBusy) return;

    setIsStarting(true);
    setStartError(null);

    try {
      await attemptsApi.startDevServer(effectiveWorkspaceId);
      openOrFocusPanel(PANEL_IDS.DEV_PREVIEW, 'Dev Preview');
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : error &&
                typeof error === 'object' &&
                'message' in error &&
                typeof error.message === 'string'
              ? error.message
              : JSON.stringify(error);

      console.error('Failed to start dev server:', error);
      setStartError(message);

      if (message.toLowerCase().includes('no dev server script')) {
        setShowDevConfig(true);
      } else {
        setShowStartErrorDialog(true);
      }
    } finally {
      setIsStarting(false);
    }
  }, [
    effectiveWorkspaceId,
    aiHostedDevStart.isBusy,
    isStarting,
    openOrFocusPanel,
  ]);

  const handleSaveDevCommand = useCallback(async () => {
    if (!effectiveWorkspaceId || !devCommand.trim()) return;

    try {
      const repos = await attemptsApi.getRepos(effectiveWorkspaceId);
      if (repos.length === 0) return;

      const repoId = repos[0].id;
      const updateData: UpdateRepo = { dev_server_script: devCommand.trim() };
      await repoApi.update(repoId, updateData);
      setShowDevConfig(false);
      setStartError(null);
      await handleStartDevServer();
    } catch (error) {
      console.error('Failed to save dev server command:', error);
    }
  }, [devCommand, effectiveWorkspaceId, handleStartDevServer]);

  const handleAiHostedStart = useCallback(async () => {
    setStartError(null);
    setShowStartErrorDialog(false);
    await aiHostedDevStart.start();
    setShowDevConfig(false);
  }, [aiHostedDevStart]);

  const handleOpenPreview = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.DEV_PREVIEW, 'Dev Preview');
  }, [openOrFocusPanel]);

  const effectiveStartError =
    startError ?? aiHostedDevStart.state?.error ?? null;
  const isDevStartBusy = isStarting || aiHostedDevStart.isBusy;

  const buttons = [
    { icon: Terminal, label: 'Open Terminal', onClick: openNewTerminal },
    {
      icon: List,
      label: 'Processes',
      onClick: () =>
        ViewProcessesDialog.show({
          sessionId: effectiveSessionId ?? attempt?.session?.id,
          initialProcessId: null,
        }),
    },
    { icon: GitCompareArrows, label: 'Git Diff', onClick: openDiffPreview },
    { icon: StickyNote, label: 'Notes', onClick: openNotes },
  ];

  return (
    <>
      <TooltipProvider delayDuration={200}>
        <div className="relative shrink-0 w-9 border-l border-border bg-secondary/30 flex flex-col items-center pt-2 gap-0.5">
          {buttons.map((button) => {
            const Icon = button.icon;
            return (
              <Tooltip key={button.label}>
                <TooltipTrigger asChild>
                  <button
                    onClick={button.onClick}
                    className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">{button.label}</TooltipContent>
              </Tooltip>
            );
          })}

          <div className="w-5 h-px bg-border my-1" />

          {effectiveWorkspaceId && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleStartDevServer}
                    disabled={isDevStartBusy}
                    className={`w-7 h-7 flex items-center justify-center rounded transition-colors disabled:opacity-40 ${
                      effectiveStartError
                        ? 'text-destructive hover:text-destructive hover:bg-destructive/10'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                    }`}
                  >
                    {isDevStartBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {isDevStartBusy
                    ? 'Starting…'
                    : effectiveStartError
                      ? `Start failed: ${effectiveStartError}`
                      : 'Start Dev Server'}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleOpenPreview}
                    className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    <Globe className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">Open Dev Preview</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      </TooltipProvider>

      <Dialog open={showDevConfig} onOpenChange={setShowDevConfig}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Configure Dev Server</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Start Command</label>
              <input
                className="w-full mt-1 px-3 py-2 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="npm run dev"
                value={devCommand}
                onChange={(event) => setDevCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void handleSaveDevCommand();
                  }
                }}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowDevConfig(false)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => void handleAiHostedStart()}
              disabled={aiHostedDevStart.isBusy}
            >
              {aiHostedDevStart.isBusy ? 'AI 托管中…' : 'AI 托管启动'}
            </Button>
            <Button
              onClick={() => void handleSaveDevCommand()}
              disabled={!devCommand.trim()}
            >
              Save & Start
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showStartErrorDialog}
        onOpenChange={setShowStartErrorDialog}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Dev Server Start Failed</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground break-words">
            {effectiveStartError || 'Unknown error'}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setShowStartErrorDialog(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
