
function errorSummary(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  if (
    cause &&
    typeof cause === 'object' &&
    'message' in cause &&
    typeof (cause as Record<string, unknown>).message === 'string'
  )
    return (cause as Record<string, string>).message;
  return String(cause);
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FolderOpen,
  GitBranch,
  Globe,
  Loader2,
  Plus,
} from 'lucide-react';
import type { Project } from 'shared/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { CloneRepoDialog } from '@/components/dialogs/projects/CloneRepoDialog';
import { projectsApi } from '@/lib/api/projects';
import { orderImportedProjects } from '@/lib/importedProject';

export function OnboardingProjects({
  initialProjectIds = [],
  active = true,
  onBack,
  onFinish,
}: {
  initialProjectIds?: readonly string[];
  /** Only the visible page owns the onboarding title anchor. */
  active?: boolean;
  onBack: () => void;
  onFinish: (projectIds: string[]) => Promise<void>;
}) {
  const { t } = useTranslation(['dialogs', 'app']);
  const queryClient = useQueryClient();
  const [projects, setProjects] = useState<Project[]>([]);
  // Selection is "everything except what the user unchecked", so imported and
  // new projects arrive selected without a separate initialization pass.
  const [deselected, setDeselected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const importedIds = useRef(new Set<string>(initialProjectIds));
  const selectedProjects = useMemo(
    () =>
      new Set(
        projects
          .map((project) => project.id)
          .filter((id) => !deselected.has(id))
      ),
    [projects, deselected]
  );

  const loadProjects = useCallback(async () => {
    const next = orderImportedProjects(
      (await projectsApi.getAll()).filter((project) => !project.hidden)
    );
    if (mounted.current) setProjects(next);
    return next;
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadProjects()
      .catch((cause) => {
        if (mounted.current)
          setError(errorSummary(cause));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [loadProjects]);

  useEffect(() => {
    if (active) document.getElementById('onboarding-title')?.focus();
  }, [active]);

  const selectProject = (project: Project) => {
    setProjects((current) =>
      orderImportedProjects([
        ...current.filter((item) => item.id !== project.id),
        project,
      ])
    );
    setDeselected((current) => {
      const next = new Set(current);
      next.delete(project.id);
      return next;
    });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  };

  const projectAction = async (action: 'open' | 'new' | 'clone') => {
    setError(null);
    setDialogOpen(true);
    try {
      if (action === 'clone') {
        const result = await CloneRepoDialog.show();
        if (result?.status === 'cloned') {
          const name = result.repo.display_name || result.repo.name;
          selectProject(
            await projectsApi.create({
              name,
              repositories: [
                { display_name: name, git_repo_path: result.repo.path },
              ],
            })
          );
        }
      } else {
        const result = await ProjectFormDialog.show({
          autoOpenFolderPicker: action === 'open',
        });
        if (result?.status === 'saved') selectProject(result.project);
      }
    } catch (cause) {
      setError(errorSummary(cause));
    } finally {
      setDialogOpen(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await onFinish([...selectedProjects]);
    } catch (cause) {
      setError(errorSummary(cause));
    } finally {
      setBusy(false);
    }
  };

  const importedProjects = projects.filter((project) =>
    importedIds.current.has(project.id)
  );

  return (
    <main className="onboarding-projects-step" inert={dialogOpen}>
      <header className="onboarding-page-heading">
        <h1 id={active ? 'onboarding-title' : undefined} tabIndex={-1}>
          {t('onboarding.projectsTitle')}
        </h1>
        <p>{t('onboarding.projectsDescription')}</p>
      </header>
      <div className="onboarding-page-content">
        {error ? (
          <p className="onboarding-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        {importedProjects.length ? (
          <p className="onboarding-import-receipt" role="status">
            <Check aria-hidden="true" className="size-4" />
            {t('onboarding.importedProjectsReceipt', {
              count: importedProjects.length,
            })}
          </p>
        ) : null}
        {loading ? (
          <p className="onboarding-history-wait" role="status">
            <Loader2
              aria-hidden="true"
              className="size-4 motion-safe:animate-spin"
            />
            {t('onboarding.loadingProjects')}
          </p>
        ) : (
          <ul className="onboarding-project-list">
            {projects.map((project) => (
              <li key={project.id}>
                <label className="onboarding-project-row">
                  <Checkbox
                    aria-label={
                      project.is_home
                        ? t('app:welcomePage.globalProject')
                        : project.name
                    }
                    checked={selectedProjects.has(project.id)}
                    onCheckedChange={(value) =>
                      setDeselected((current) => {
                        const next = new Set(current);
                        if (value === true) next.delete(project.id);
                        else next.add(project.id);
                        return next;
                      })
                    }
                  />
                  <span className="onboarding-project-icon">
                    {project.is_home ? <Globe /> : <FolderOpen />}
                  </span>
                  <span className="onboarding-project-copy">
                    <strong>
                      {project.is_home
                        ? t('app:welcomePage.globalProject')
                        : project.name}
                    </strong>
                    <span className="onboarding-project-path">
                      {project.is_home
                        ? t('onboarding.globalDescription')
                        : project.root_path}
                    </span>
                  </span>
                  {importedIds.current.has(project.id) ? (
                    <span className="onboarding-project-origin">
                      {t('onboarding.importedProjectBadge')}
                    </span>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
        )}
        {!loading && !projects.length ? (
          <Button
            variant="outline"
            onClick={() =>
              void loadProjects().catch((cause) =>
                setError(errorSummary(cause))
              )
            }
          >
            {t('onboarding.retry')}
          </Button>
        ) : null}
        <div className="onboarding-project-actions">
          {(['open', 'new', 'clone'] as const).map((action) => (
            <Button
              variant="outline"
              key={action}
              onClick={() => void projectAction(action)}
            >
              {action === 'open' ? (
                <FolderOpen className="size-4" />
              ) : action === 'new' ? (
                <Plus className="size-4" />
              ) : (
                <GitBranch className="size-4" />
              )}
              {t(`onboarding.projectAction.${action}`)}
            </Button>
          ))}
        </div>
      </div>
      <footer className="onboarding-page-footer">
        <Button variant="ghost" disabled={busy} onClick={onBack}>
          <ArrowLeft className="size-4" />
          {t('onboarding.back')}
        </Button>
        <Button
          disabled={busy || selectedProjects.size === 0}
          isLoading={busy}
          onClick={() => void finish()}
        >
          {t('onboarding.next')}
          <ArrowRight className="size-4" />
        </Button>
      </footer>
    </main>
  );
}
