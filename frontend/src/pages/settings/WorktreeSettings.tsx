import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, GitFork, TerminalSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project } from 'shared/types';

import { toast } from '@/components/ui/toast';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  projectsApi,
  type ProjectWorktreeSettings,
  type WorktreeCleanupStatus,
  worktreeSettingsApi,
} from '@/lib/api';
import { SETTINGS_CHANGED_EVENT } from '@/lib/frontendPreferences';
import {
  SettingsActionBar,
  SettingsPageHeader,
  SettingsSection,
} from './SettingsUi';

const EMPTY_SETTINGS: ProjectWorktreeSettings = {
  create_command: null,
  delete_command: null,
  cleanup_prompt_enabled: false,
  cleanup_prompt_threshold: 5,
};

function cloneSettings(settings: ProjectWorktreeSettings) {
  return { ...settings };
}

export function WorktreeSettings() {
  const { t } = useTranslation('settings');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [draft, setDraft] = useState<ProjectWorktreeSettings>(EMPTY_SETTINGS);
  const [saved, setSaved] = useState<ProjectWorktreeSettings>(EMPTY_SETTINGS);
  const [status, setStatus] = useState<WorktreeCleanupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const loadProjects = async () => {
      try {
        const nextProjects = await projectsApi.getAll();
        if (cancelled) return;
        setProjects(nextProjects);
        setProjectId((current) => current || nextProjects[0]?.id || '');
      } catch (error) {
        toast.error(t('worktrees.loadFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
        setLoading(false);
      }
    };
    void loadProjects();
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const loadSettings = () => {
      if (dirtyRef.current) return;
      setLoading(true);
      void Promise.all([
        worktreeSettingsApi.get(projectId),
        worktreeSettingsApi.getCleanupStatus(projectId),
      ])
        .then(([settings, nextStatus]) => {
          if (cancelled) return;
          setDraft(cloneSettings(settings));
          setSaved(cloneSettings(settings));
          setStatus(nextStatus);
        })
        .catch((error) => {
          if (cancelled) return;
          toast.error(t('worktrees.loadFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    loadSettings();
    window.addEventListener('focus', loadSettings);
    window.addEventListener(SETTINGS_CHANGED_EVENT, loadSettings);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', loadSettings);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, loadSettings);
    };
  }, [projectId, t]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved]
  );
  dirtyRef.current = dirty;

  const updateDraft = useCallback((patch: Partial<ProjectWorktreeSettings>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const save = useCallback(async () => {
    if (!projectId) return;
    setSaving(true);
    try {
      const next = await worktreeSettingsApi.update(projectId, draft);
      setDraft(cloneSettings(next));
      setSaved(cloneSettings(next));
      setStatus(await worktreeSettingsApi.getCleanupStatus(projectId));
      toast.success(t('worktrees.saved'));
    } catch (error) {
      toast.error(t('worktrees.saveFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  }, [draft, projectId, t]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-20">
      <SettingsPageHeader
        title={t('worktrees.title')}
        description={t('worktrees.description')}
      />

      <SettingsSection
        icon={GitFork}
        title={t('worktrees.projectTitle')}
        description={t('worktrees.projectDescription')}
      >
        <div className="settings-row items-center gap-4 px-4 py-3">
          <Label htmlFor="worktree-project" className="min-w-32">
            {t('worktrees.projectLabel')}
          </Label>
          <select
            id="worktree-project"
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            disabled={loading || projects.length === 0}
          >
            {projects.length === 0 ? (
              <option value="">{t('worktrees.noProjects')}</option>
            ) : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={TerminalSquare}
        title={t('worktrees.commandsTitle')}
        description={t('worktrees.commandsDescription')}
      >
        <div className="settings-row block space-y-2 px-4 py-3">
          <Label htmlFor="worktree-create-command">
            {t('worktrees.createCommand')}
          </Label>
          <Textarea
            id="worktree-create-command"
            className="min-h-20 font-mono text-xs"
            value={draft.create_command ?? ''}
            onChange={(event) =>
              updateDraft({ create_command: event.target.value || null })
            }
            placeholder={t('worktrees.createCommandPlaceholder')}
            disabled={loading || !projectId}
          />
          <p className="text-xs text-muted-foreground">
            {t('worktrees.createCommandHint')}
          </p>
        </div>
        <div className="settings-row block space-y-2 px-4 py-3">
          <Label htmlFor="worktree-delete-command">
            {t('worktrees.deleteCommand')}
          </Label>
          <Textarea
            id="worktree-delete-command"
            className="min-h-20 font-mono text-xs"
            value={draft.delete_command ?? ''}
            onChange={(event) =>
              updateDraft({ delete_command: event.target.value || null })
            }
            placeholder={t('worktrees.deleteCommandPlaceholder')}
            disabled={loading || !projectId}
          />
          <p className="text-xs text-muted-foreground">
            {t('worktrees.deleteCommandHint')}
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={AlertTriangle}
        title={t('worktrees.cleanupTitle')}
        description={t('worktrees.cleanupDescription')}
      >
        <div className="settings-row items-center justify-between gap-4 px-4 py-3">
          <div>
            <Label htmlFor="worktree-cleanup-prompt">
              {t('worktrees.cleanupPrompt')}
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('worktrees.cleanupPromptHint')}
            </p>
          </div>
          <Switch
            id="worktree-cleanup-prompt"
            checked={draft.cleanup_prompt_enabled}
            onCheckedChange={(checked) =>
              updateDraft({ cleanup_prompt_enabled: checked })
            }
            disabled={loading || !projectId}
          />
        </div>
        <div className="settings-row items-center justify-between gap-4 px-4 py-3">
          <Label htmlFor="worktree-cleanup-threshold">
            {t('worktrees.cleanupThreshold')}
          </Label>
          <Input
            id="worktree-cleanup-threshold"
            type="number"
            min={1}
            max={999}
            className="w-24 text-right"
            value={draft.cleanup_prompt_threshold}
            onChange={(event) =>
              updateDraft({
                cleanup_prompt_threshold: Math.max(
                  1,
                  Number.parseInt(event.target.value, 10) || 1
                ),
              })
            }
            disabled={loading || !projectId || !draft.cleanup_prompt_enabled}
          />
        </div>
        {status?.should_prompt ? (
          <div
            className="settings-row gap-2 px-4 py-3 text-sm text-warning"
            role="status"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {t('worktrees.cleanupRecommended', {
                count: status.current_count,
                threshold: status.threshold,
              })}
            </span>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsActionBar
        dirty={dirty}
        saving={saving}
        onDiscard={() => setDraft(cloneSettings(saved))}
        onSave={() => void save()}
        disabled={!projectId || draft.cleanup_prompt_threshold < 1}
      />
    </div>
  );
}
