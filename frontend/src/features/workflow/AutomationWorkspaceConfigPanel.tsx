import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { Workspace } from 'shared/types';

import { TextInput } from '@astryxdesign/core/TextInput';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

import { daysInMonth, type ScheduleTimer } from './automationEditorPresets';
import type { WorkflowTestWorkspaceMode } from './workflowTestWorkspaceStore';

export type AutomationWorkspaceMode = 'existing' | 'new';

export type AutomationProjectOption = {
  id: string;
  name: string;
};

type AutomationWorkspaceConfigPanelProps = {
  projectId: string;
  setProjectId: (id: string) => void;
  projects: AutomationProjectOption[];
  workspaceMode: AutomationWorkspaceMode;
  setWorkspaceMode: (mode: AutomationWorkspaceMode) => void;
  workspaceId: string;
  setWorkspaceId: (id: string) => void;
  workspaces: Workspace[];
  testWorkspaceMode: WorkflowTestWorkspaceMode | null;
  setTestWorkspaceMode: (mode: WorkflowTestWorkspaceMode) => void;
  testWorkspaceId: string | null;
  setTestWorkspaceId: (id: string) => void;
  testWorktrees: Workspace[];
  persistTestWorkspace: (
    mode: WorkflowTestWorkspaceMode | null,
    workspaceId: string | null,
    workspaceIds: string[]
  ) => void;
  recordTestWorkspace: (
    workspace: Workspace,
    mode?: WorkflowTestWorkspaceMode
  ) => void;
  sourcePath: string;
  setSourcePath: (path: string) => void;
  triggerKind: 'manual' | 'schedule';
  setTriggerKind: (kind: 'manual' | 'schedule') => void;
  timer: ScheduleTimer;
  setTimer: Dispatch<SetStateAction<ScheduleTimer>>;
  timezone: string;
  setTimezone: (tz: string) => void;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
};

export function AutomationWorkspaceConfigPanel({
  projectId,
  setProjectId,
  projects,
  workspaceMode,
  setWorkspaceMode,
  workspaceId,
  setWorkspaceId,
  workspaces,
  testWorkspaceMode,
  setTestWorkspaceMode,
  testWorkspaceId,
  setTestWorkspaceId,
  testWorktrees,
  persistTestWorkspace,
  recordTestWorkspace,
  sourcePath,
  setSourcePath,
  triggerKind,
  setTriggerKind,
  timer,
  setTimer,
  timezone,
  setTimezone,
  enabled,
  setEnabled,
}: AutomationWorkspaceConfigPanelProps) {
  const { t } = useTranslation(['settings', 'common']);

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>{t('automations.project')}</Label>
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger>
            <SelectValue placeholder={t('automations.selectProject')} />
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>{t('automations.runtimeWorkspace')}</Label>
        <Select
          value={workspaceMode}
          onValueChange={(value: AutomationWorkspaceMode) =>
            setWorkspaceMode(value)
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="existing">
              {t('automations.existingWorkspace')}
            </SelectItem>
            <SelectItem value="new">{t('automations.newWorkspace')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {workspaceMode === 'existing' ? (
        <div className="space-y-1.5">
          <Label>{t('automations.workspaceLocation')}</Label>
          <Select value={workspaceId} onValueChange={setWorkspaceId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project-root">
                {t('automations.projectDirectory')}
              </SelectItem>
              {workspaces
                .filter((workspace) => workspace.use_worktree)
                .map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.name || workspace.branch}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label>{t('automations.workspaceLocation')}</Label>
          <div className="flex h-8 items-center rounded-lg bg-[var(--surface-control)] px-2.5 text-xs text-muted-foreground">
            {t('automations.worktreePerRun')}
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label>{t('automations.testWorkspace')}</Label>
        <Select
          value={testWorkspaceMode ?? undefined}
          onValueChange={(value: WorkflowTestWorkspaceMode) => {
            setTestWorkspaceMode(value);
            persistTestWorkspace(
              value,
              testWorkspaceId,
              testWorktrees.map((item) => item.id)
            );
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder={t('automations.chooseTestWorkspace')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="existing">
              {t('automations.existingWorkspace')}
            </SelectItem>
            <SelectItem value="new">{t('automations.newWorkspace')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {testWorkspaceMode === 'existing' ? (
        <div className="space-y-1.5">
          <Label>{t('automations.workspaceLocation')}</Label>
          <Select
            value={testWorkspaceId ?? undefined}
            onValueChange={(value) => {
              setTestWorkspaceId(value);
              const known =
                testWorktrees.find((item) => item.id === value) ??
                workspaces.find((item) => item.id === value);
              if (known) recordTestWorkspace(known);
              else
                persistTestWorkspace(
                  'existing',
                  value,
                  testWorktrees.map((item) => item.id)
                );
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {testWorktrees.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.name?.trim() || workspace.branch}
                </SelectItem>
              ))}
              {workspaces
                .filter(
                  (workspace) =>
                    workspace.use_worktree &&
                    !testWorktrees.some((item) => item.id === workspace.id)
                )
                .map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.name || workspace.branch}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label>{t('automations.sourceArtifact')}</Label>
        <TextInput
          label={t('automations.sourceArtifact')}
          isLabelHidden
          value={sourcePath}
          onChange={setSourcePath}
          width="100%"
          className="[&_input]:font-mono [&_input]:text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <Label>{t('automations.trigger')}</Label>
        <Select
          value={triggerKind}
          onValueChange={(value: 'manual' | 'schedule') =>
            setTriggerKind(value)
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="manual">
              {t('automations.triggerManual')}
            </SelectItem>
            <SelectItem value="schedule">
              {t('automations.schedule')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {triggerKind === 'schedule' ? (
        <>
          <div className="space-y-1.5">
            <Label>{t('automations.scheduleMode')}</Label>
            <Select
              value={timer.mode}
              onValueChange={(value: ScheduleTimer['mode']) =>
                setTimer((current) => ({ ...current, mode: value }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="once">
                  {t('automations.scheduleOnce')}
                </SelectItem>
                <SelectItem value="repeat">
                  {t('automations.scheduleRepeat')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {timer.mode === 'once' ? (
            <div className="space-y-1.5">
              <Label>{t('automations.scheduleDate')}</Label>
              <div className="grid grid-cols-3 gap-1.5">
                <Select
                  value={String(timer.onceYear)}
                  onValueChange={(value) =>
                    setTimer((current) => ({
                      ...current,
                      onceYear: Number(value),
                    }))
                  }
                >
                  <SelectTrigger aria-label={t('automations.year')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from(
                      { length: 8 },
                      (_, index) => new Date().getFullYear() + index
                    ).map((year) => (
                      <SelectItem key={year} value={String(year)}>
                        {year}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={String(timer.onceMonth)}
                  onValueChange={(value) =>
                    setTimer((current) => ({
                      ...current,
                      onceMonth: Number(value),
                    }))
                  }
                >
                  <SelectTrigger aria-label={t('automations.month')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 12 }, (_, index) => index + 1).map(
                      (month) => (
                        <SelectItem key={month} value={String(month)}>
                          {month}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
                <Select
                  value={String(timer.onceDay)}
                  onValueChange={(value) =>
                    setTimer((current) => ({
                      ...current,
                      onceDay: Number(value),
                    }))
                  }
                >
                  <SelectTrigger aria-label={t('automations.day')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from(
                      { length: daysInMonth(timer.onceYear, timer.onceMonth) },
                      (_, index) => index + 1
                    ).map((day) => (
                      <SelectItem key={day} value={String(day)}>
                        {day}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>{t('automations.repeatKind')}</Label>
              <Select
                value={timer.repeatKind}
                onValueChange={(value: ScheduleTimer['repeatKind']) =>
                  setTimer((current) => ({ ...current, repeatKind: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">
                    {t('automations.repeatDaily')}
                  </SelectItem>
                  <SelectItem value="monthly">
                    {t('automations.repeatMonthly')}
                  </SelectItem>
                </SelectContent>
              </Select>
              {timer.repeatKind === 'monthly' ? (
                <Select
                  value={String(timer.repeatDay)}
                  onValueChange={(value) =>
                    setTimer((current) => ({
                      ...current,
                      repeatDay: Number(value),
                    }))
                  }
                >
                  <SelectTrigger aria-label={t('automations.day')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 31 }, (_, index) => index + 1).map(
                      (day) => (
                        <SelectItem key={day} value={String(day)}>
                          {day}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="automation-schedule-time">
              {t('automations.runTime')}
            </Label>
            <Input
              id="automation-schedule-time"
              type="time"
              value={timer.time}
              onChange={(event) =>
                setTimer((current) => ({
                  ...current,
                  time: event.target.value,
                }))
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('automations.timezone')}</Label>
            <TextInput
              label={t('automations.timezone')}
              isLabelHidden
              value={timezone}
              onChange={setTimezone}
              width="100%"
              className="[&_input]:text-sm"
            />
          </div>
        </>
      ) : null}

      <label className="flex items-center gap-2 py-1 text-xs">
        <Switch checked={enabled} onCheckedChange={setEnabled} />
        {t('automations.enabled')}
      </label>
    </div>
  );
}
