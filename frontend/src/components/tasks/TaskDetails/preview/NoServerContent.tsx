import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink,
  Loader2,
  Play,
  Settings,
  Square,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useProjectRepos } from '@/hooks';
import { useAiHostedDevServerStart } from '@/hooks/useAiHostedDevServerStart';
import { repoApi, settingsWindowApi } from '@/lib/api';
import type { Project, Repo } from 'shared/types';

interface NoServerContentProps {
  workspaceId?: string;
  projectHasDevScript: boolean;
  runningDevServer: boolean;
  isStartingDevServer: boolean;
  startDevServer: () => void;
  stopDevServer: () => void;
  project: Project | undefined;
  hasFailedDevServer?: boolean;
  onFixDevScript?: () => void;
  installWebCompanion: () => void;
  isInstallingCompanion?: boolean;
  startError?: string | null;
}

export function NoServerContent({
  workspaceId,
  projectHasDevScript,
  runningDevServer,
  isStartingDevServer,
  startDevServer,
  stopDevServer,
  project,
  hasFailedDevServer,
  onFixDevScript,
  installWebCompanion,
  isInstallingCompanion = false,
  startError = null,
}: NoServerContentProps) {
  const queryClient = useQueryClient();
  const { data: projectRepos = [] } = useProjectRepos(project?.id);
  const aiHostedDevStart = useAiHostedDevServerStart(workspaceId);
  const [scriptInput, setScriptInput] = useState('');

  const saveScriptMutation = useMutation({
    mutationFn: async (script: string) => {
      if (projectRepos.length === 0) return;

      await Promise.all(
        projectRepos
          .filter((repo: Repo) => !repo.dev_server_script?.trim())
          .map((repo: Repo) =>
            repoApi.update(repo.id, { dev_server_script: script })
          )
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['projectRepositories'],
      });
      await queryClient.invalidateQueries({
        queryKey: ['hasDevServerScript'],
      });
      startDevServer();
    },
  });

  const effectiveStartError = startError ?? aiHostedDevStart.state?.error ?? null;

  const handleSaveAndStart = () => {
    const trimmed = scriptInput.trim();
    if (!trimmed) return;
    saveScriptMutation.mutate(trimmed);
  };

  const handleAiHostedStart = async () => {
    aiHostedDevStart.clearError();
    await aiHostedDevStart.start();
  };

  const handleConfigureDevScript = () => {
    settingsWindowApi.open();
  };

  const isBusy =
    isStartingDevServer ||
    saveScriptMutation.isPending ||
    aiHostedDevStart.isBusy;

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="mx-auto max-w-md space-y-6 p-6 text-center">
        <div className="flex items-center justify-center">
          <SquareTerminal className="h-8 w-8 text-muted-foreground" />
        </div>

        <div className="space-y-4">
          {effectiveStartError && (
            <Alert variant="destructive" className="text-left text-sm">
              <p className="font-medium">开发服务器启动失败</p>
              <p>{effectiveStartError}</p>
            </Alert>
          )}

          <div>
            <h3 className="mb-2 text-lg font-medium text-foreground">
              当前没有运行中的开发服务器
            </h3>
            <p className="text-sm text-muted-foreground">
              {projectHasDevScript
                ? '你可以直接启动开发服务器，或者交给 AI 自动分析项目并完成启动。'
                : '请输入启动命令，或使用 AI 托管启动自动检查依赖、环境并尝试启动。'}
            </p>
          </div>

          {!projectHasDevScript && !runningDevServer && (
            <div className="space-y-3 text-left">
              <label className="text-sm font-medium text-foreground">
                启动命令
              </label>
              <input
                type="text"
                value={scriptInput}
                onChange={(event) => setScriptInput(event.target.value)}
                placeholder="npm run dev"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={handleSaveAndStart}
                  disabled={!scriptInput.trim() || isBusy}
                  className="gap-1"
                >
                  <Play className="h-4 w-4" />
                  保存并启动
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleAiHostedStart()}
                  disabled={aiHostedDevStart.isBusy}
                  className="gap-1"
                >
                  {aiHostedDevStart.isBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Settings className="h-4 w-4" />
                  )}
                  AI 托管启动
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                AI 会分析当前项目、补齐依赖与环境，并在成功后直接回复可访问地址或构建产物路径。
              </p>
            </div>
          )}

          {(projectHasDevScript || runningDevServer) && (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                size="sm"
                variant={runningDevServer ? 'destructive' : 'default'}
                onClick={() => {
                  if (runningDevServer) {
                    stopDevServer();
                  } else {
                    startDevServer();
                  }
                }}
                disabled={isStartingDevServer || !projectHasDevScript}
                className="gap-1"
              >
                {runningDevServer ? (
                  <>
                    <Square className="h-4 w-4" />
                    停止开发服务器
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" />
                    启动开发服务器
                  </>
                )}
              </Button>

              {!runningDevServer && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleAiHostedStart()}
                  disabled={aiHostedDevStart.isBusy}
                  className="gap-1"
                >
                  {aiHostedDevStart.isBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Settings className="h-4 w-4" />
                  )}
                  AI 托管启动
                </Button>
              )}

              {!runningDevServer && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleConfigureDevScript}
                  className="gap-1"
                >
                  <Settings className="h-3 w-3" />
                  配置
                </Button>
              )}

              {hasFailedDevServer && onFixDevScript && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onFixDevScript}
                  className="gap-1"
                >
                  <Wrench className="h-4 w-4" />
                  修复启动脚本
                </Button>
              )}
            </div>
          )}

          <div className="space-y-4 border-t border-border pt-6">
            <p className="text-sm text-muted-foreground">
              如果你希望在预览页中点击页面元素后回到编辑器，请先为当前前端项目安装 Web Companion。
            </p>
            <div className="space-y-2">
              <Button
                size="sm"
                onClick={installWebCompanion}
                disabled={!project || isInstallingCompanion}
                className="gap-1"
                variant="outline"
              >
                {isInstallingCompanion ? '正在安装 Companion…' : '自动安装 Companion'}
              </Button>
              <div>
                <a
                  href="https://github.com/vibe-ultra/vibe-ultra-web-companion"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400"
                >
                  <ExternalLink className="h-3 w-3" />
                  查看安装指南
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
