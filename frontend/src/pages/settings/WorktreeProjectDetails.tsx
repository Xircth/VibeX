import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Repo, Workspace } from 'shared/types';
import { attemptsApi, projectsApi, repoApi } from '@/lib/api';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function RepositoryCopyFiles({ repo }: { repo: Repo }) {
  const { t } = useTranslation('settings');
  const [value, setValue] = useState(repo.copy_files ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await repoApi.update(repo.id, { copy_files: value });
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-2">
      <Label htmlFor={`copy-${repo.id}`}>
        {repo.display_name || repo.name}
      </Label>
      <p className="break-all text-sm text-muted-foreground">
        {t('worktrees.commandDirectory', {
          path: [repo.name, repo.default_working_dir].filter(Boolean).join('/'),
        })}
      </p>
      <Input
        id={`copy-${repo.id}`}
        value={value}
        disabled={saving}
        placeholder=".env, config/*.local"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
      />
      {error && (
        <div role="alert">
          <p className="break-all text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={() => void save()}>
            {t('worktrees.retry')}
          </Button>
        </div>
      )}
    </div>
  );
}

function ManagedWorkspace({
  workspace,
  onChanged,
}: {
  workspace: Workspace;
  onChanged: () => void;
}) {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<Awaited<
    ReturnType<typeof attemptsApi.getInitialization>
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = await attemptsApi.getInitialization(workspace.id);
        if (cancelled) return;
        setStatus(result);
        if (result.active) timer = setTimeout(() => void refresh(), 1000);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    workspace.id,
    workspace.setup_completed_at,
    workspace.container_ref,
    busy,
  ]);
  const act = async (action: 'retry' | 'delete') => {
    const confirmed = await ConfirmDialog.show({
      title: t(`worktrees.${action}Workspace`),
      message: t(`worktrees.${action}WorkspaceConfirm`, {
        branch: workspace.branch,
      }),
      variant: action === 'delete' ? 'destructive' : 'info',
    });
    if (confirmed !== 'confirmed') return;
    setBusy(true);
    setError('');
    try {
      if (action === 'delete') await attemptsApi.delete(workspace.id, false);
      else {
        await attemptsApi.retryInitialization(workspace.id);
        setStatus(await attemptsApi.getInitialization(workspace.id));
      }
      onChanged();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="space-y-2 border-b border-border py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-all text-sm font-medium">
          {workspace.name || workspace.branch}
        </span>
        <div className="flex gap-2">
          {status?.active && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void attemptsApi
                  .cancelInitialization(workspace.id)
                  .catch((e) => setError(String(e)))
              }
            >
              {t('worktrees.cancelInitialization')}
            </Button>
          )}
          {status &&
            !status.active &&
            ['failed', 'running', 'preparing', 'pending'].includes(
              status.phase
            ) && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void act('retry')}
              >
                {t('worktrees.retryWorkspace')}
              </Button>
            )}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void act('delete')}
          >
            {t('worktrees.deleteWorkspace')}
          </Button>
        </div>
      </div>
      <p className="break-all text-sm text-muted-foreground">
        {workspace.container_ref || t('worktrees.notMaterialized')}
      </p>
      {status && (
        <p className="text-sm text-muted-foreground">
          {t(`worktrees.phase.${status.phase}`, { defaultValue: status.phase })}
        </p>
      )}
      {(error || status?.error) && (
        <pre
          role="alert"
          className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs text-destructive"
        >
          {error || status?.error}
        </pre>
      )}
      {status?.logs && (
        <details>
          <summary className="cursor-pointer text-sm">
            {t('worktrees.output')}
          </summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
            {status.logs}
          </pre>
        </details>
      )}
    </li>
  );
}

export function WorktreeProjectDetails({ projectId }: { projectId: string }) {
  const { t } = useTranslation('settings');
  const [repos, setRepos] = useState<Repo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      projectsApi.getRepositories(projectId),
      attemptsApi.getProjectWorkspaces(projectId),
    ])
      .then(([repos, workspaces]) => {
        if (cancelled) return;
        setRepos(repos);
        setWorkspaces(workspaces.filter((workspace) => workspace.use_worktree));
        setError('');
      })
      .catch((error) => {
        if (!cancelled) setError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, revision]);
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <h4>{t('worktrees.copyFiles')}</h4>
        <p className="settings-row__description">
          {t('worktrees.copyFilesHint')}
        </p>
        {repos.map((repo) => (
          <RepositoryCopyFiles key={repo.id} repo={repo} />
        ))}
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4>{t('worktrees.manage')}</h4>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRevision((value) => value + 1)}
          >
            {t('worktrees.refresh')}
          </Button>
        </div>
        {error && (
          <p role="alert" className="break-all text-sm text-destructive">
            {error}
          </p>
        )}
        <ul>
          {workspaces.map((workspace) => (
            <ManagedWorkspace
              key={workspace.id}
              workspace={workspace}
              onChanged={() => setRevision((value) => value + 1)}
            />
          ))}
        </ul>
        {!error && workspaces.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t('worktrees.noWorkspaces')}
          </p>
        )}
      </div>
    </div>
  );
}
