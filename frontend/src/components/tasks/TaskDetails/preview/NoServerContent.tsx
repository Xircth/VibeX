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
import { repoApi, settingsWindowApi } from '@/lib/api';
import type { Project, Repo } from 'shared/types';

interface NoServerContentProps {
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

  const handleSaveAndStart = () => {
    const trimmed = scriptInput.trim();
    if (!trimmed) return;
    saveScriptMutation.mutate(trimmed);
  };

  const handleConfigureDevScript = () => {
    settingsWindowApi.open();
  };

  const isBusy = isStartingDevServer || saveScriptMutation.isPending;

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="mx-auto max-w-md space-y-6 p-6 text-center">
        <div className="flex items-center justify-center">
          <SquareTerminal className="h-8 w-8 text-muted-foreground" />
        </div>

        <div className="space-y-4">
          {startError ? (
            <Alert variant="destructive" className="text-left text-sm">
              <p className="font-medium">开发服务器启动失败</p>
              <p>{startError}</p>
            </Alert>
          ) : null}

          <div>
            <h3 className="mb-2 text-lg font-medium text-foreground">
              启动项目开发服务器
            </h3>
            <p className="text-sm text-muted-foreground">
              {projectHasDevScript
                ? '你可以直接启动开发服务器，或在会话输入框中使用 #启动项目开发服务器 标签提示 Agent 处理启动。'
                : '请输入启动命令，或在会话输入框中使用 #启动项目开发服务器 标签提示 Agent 处理启动。'}
            </p>
          </div>

          {!projectHasDevScript && !runningDevServer ? (
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
              </div>
            </div>
          ) : null}

          {projectHasDevScript || runningDevServer ? (
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

              {!runningDevServer ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleConfigureDevScript}
                  className="gap-1"
                >
                  <Settings className="h-3 w-3" />
                  设置
                </Button>
              ) : null}

              {hasFailedDevServer && onFixDevScript ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onFixDevScript}
                  className="gap-1"
                >
                  <Wrench className="h-4 w-4" />
                  修复启动脚本
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-4 border-t border-border pt-6">
            <p className="text-sm text-muted-foreground">
              如果需要在预览中启用点击组件定位，请安装 VibeX Web Companion。
            </p>
            <div className="space-y-2">
              <Button
                size="sm"
                onClick={installWebCompanion}
                disabled={!project || isInstallingCompanion}
                className="gap-1"
                variant="outline"
              >
                {isInstallingCompanion ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在安装 Companion
                  </>
                ) : (
                  '安装 Companion'
                )}
              </Button>
              <div>
                <a
                  href="https://github.com/vibex/vibex-web-companion"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400"
                >
                  <ExternalLink className="h-3 w-3" />
                  查看 Companion 仓库
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
