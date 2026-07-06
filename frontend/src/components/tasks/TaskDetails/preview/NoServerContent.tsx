import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  onPreviewUrlSubmit: (url: string) => void;
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
  onPreviewUrlSubmit,
}: NoServerContentProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const queryClient = useQueryClient();
  const { data: projectRepos = [] } = useProjectRepos(project?.id);
  const [scriptInput, setScriptInput] = useState('');
  const [previewUrlInput, setPreviewUrlInput] = useState('');

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

  const handleOpenPreviewUrl = () => {
    const trimmed = previewUrlInput.trim();
    if (!trimmed) return;
    onPreviewUrlSubmit(trimmed);
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
              <p className="font-medium">
                {t('noServerContent.startFailedTitle')}
              </p>
              <p>{startError}</p>
            </Alert>
          ) : null}

          <div>
            <h3 className="mb-2 text-lg font-medium text-foreground">
              {t('noServerContent.title')}
            </h3>
            <p className="text-sm text-muted-foreground">
              {projectHasDevScript
                ? t('noServerContent.descriptionWithScript')
                : t('noServerContent.descriptionWithoutScript')}
            </p>
          </div>

          <div className="space-y-3 text-left">
            <label className="text-sm font-medium text-foreground">
              {t('noServerContent.previewUrlLabel')}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={previewUrlInput}
                onChange={(event) => setPreviewUrlInput(event.target.value)}
                onKeyDown={(event) =>
                  event.key === 'Enter' && handleOpenPreviewUrl()
                }
                placeholder="http://localhost:3000"
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              />
              <Button
                size="sm"
                onClick={handleOpenPreviewUrl}
                disabled={!previewUrlInput.trim()}
              >
                {t('noServerContent.enterPreview')}
              </Button>
            </div>
          </div>

          {!projectHasDevScript && !runningDevServer ? (
            <div className="space-y-3 text-left">
              <label className="text-sm font-medium text-foreground">
                {t('noServerContent.startCommandLabel')}
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
                  {t('noServerContent.saveAndStart')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleConfigureDevScript}
                  disabled={isBusy}
                  className="gap-1"
                >
                  <Settings className="h-4 w-4" />
                  {t('noServerContent.modifyCommand')}
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
                    {t('noServerContent.stopDevServer')}
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" />
                    {t('noServerContent.startDevServer')}
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
                  {t('noServerContent.settings')}
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
                  {t('noServerContent.fixStartScript')}
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-4 border-t border-border pt-6">
            <p className="text-sm text-muted-foreground">
              {t('noServerContent.companionDescription')}
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
                    {t('noServerContent.installingCompanion')}
                  </>
                ) : (
                  t('noServerContent.installCompanion')
                )}
              </Button>
              <div>
                <a
                  href="https://github.com/vibex/vibex-web-companion"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  {t('noServerContent.viewCompanionRepo')}
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
