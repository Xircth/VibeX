import { useState, useCallback } from 'react';
import { Terminal, List, GitCompareArrows, StickyNote, Play, Globe, Loader2 } from 'lucide-react';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { ViewProcessesDialog } from '@/components/dialogs/tasks/ViewProcessesDialog';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
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
  const { openNewTerminal, openDiffPreview, openNotes, openOrFocusPanel } = usePanelActionsContext();
  const { activeWorktreeId } = useWorktree();
  const { data: attempt } = useTaskAttemptWithSession(activeWorktreeId ?? undefined);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [showStartErrorDialog, setShowStartErrorDialog] = useState(false);
  const [showDevConfig, setShowDevConfig] = useState(false);
  const [devCommand, setDevCommand] = useState('');

  const handleStartDevServer = useCallback(async () => {
    if (!activeWorktreeId || isStarting) return;
    setIsStarting(true);
    setStartError(null);
    try {
      await attemptsApi.startDevServer(activeWorktreeId);
      // Auto-open the Preview panel after successfully starting
      openOrFocusPanel(PANEL_IDS.DEV_PREVIEW, 'Dev Preview');
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
            ? err.message
            : JSON.stringify(err);
      console.error('Failed to start dev server:', err);
      setStartError(message);
      if (typeof message === 'string' && message.toLowerCase().includes('no dev server script')) {
        setShowDevConfig(true);
      } else {
        setShowStartErrorDialog(true);
      }
    } finally {
      setIsStarting(false);
    }
  }, [activeWorktreeId, isStarting, openOrFocusPanel]);

  const handleSaveDevCommand = useCallback(async () => {
    if (!activeWorktreeId || !devCommand.trim()) return;
    try {
      const repos = await attemptsApi.getRepos(activeWorktreeId);
      if (repos.length > 0) {
        const repoId = repos[0].id;
        const updateData: UpdateRepo = { dev_server_script: devCommand.trim() };
        await repoApi.update(repoId, updateData);
        setShowDevConfig(false);
        setStartError(null);
        // Retry starting dev server
        handleStartDevServer();
      }
    } catch (err) {
      console.error('Failed to save dev server command:', err);
    }
  }, [activeWorktreeId, devCommand, handleStartDevServer]);

  const handleOpenPreview = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.DEV_PREVIEW, 'Dev Preview');
  }, [openOrFocusPanel]);

  const buttons = [
    { icon: Terminal, label: '启动终端', onClick: openNewTerminal },
    { icon: List, label: '执行进程', onClick: () => ViewProcessesDialog.show({ sessionId: attempt?.session?.id, initialProcessId: null }) },
    { icon: GitCompareArrows, label: '查看 Git Diff', onClick: openDiffPreview },
    { icon: StickyNote, label: '编辑笔记', onClick: openNotes },
  ];

  return (
    <>
      <TooltipProvider delayDuration={200}>
        <div className="relative shrink-0 w-9 border-l border-border bg-secondary/30 flex flex-col items-center pt-2 gap-0.5">
          {buttons.map((btn) => {
            const Icon = btn.icon;
            return (
              <Tooltip key={btn.label}>
                <TooltipTrigger asChild>
                  <button
                    onClick={btn.onClick}
                    className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">{btn.label}</TooltipContent>
              </Tooltip>
            );
          })}

          {/* Separator */}
          <div className="w-5 h-px bg-border my-1" />

          {/* Dev server buttons */}
          {activeWorktreeId && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleStartDevServer}
                    disabled={isStarting}
                    className={`w-7 h-7 flex items-center justify-center rounded transition-colors disabled:opacity-40 ${
                      startError
                        ? 'text-destructive hover:text-destructive hover:bg-destructive/10'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                    }`}
                  >
                    {isStarting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {isStarting
                    ? '启动中...'
                    : startError
                      ? `启动失败: ${startError}`
                      : '启动开发服务器'}
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
                <TooltipContent side="left">打开开发预览</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      </TooltipProvider>

      {/* Dev server config modal */}
      <Dialog open={showDevConfig} onOpenChange={setShowDevConfig}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>配置开发服务器</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">启动命令</label>
              <input
                className="w-full mt-1 px-3 py-2 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="npm run dev"
                value={devCommand}
                onChange={(e) => setDevCommand(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveDevCommand()}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowDevConfig(false)}>
              取消
            </Button>
            <Button onClick={handleSaveDevCommand} disabled={!devCommand.trim()}>
              保存并启动
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showStartErrorDialog} onOpenChange={setShowStartErrorDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>开发服务器启动失败</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground break-words">
            {startError || '未知错误'}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowStartErrorDialog(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
