import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, GitFork, Plus, RefreshCw } from 'lucide-react';
import type { WorkflowDefinitionSummary } from 'shared/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PendingWorkflowStudioOpenDetail } from '../pulseDeckEvents';
import type { AutomationPrimaryTab } from './automationModels';

const LazyWorkflowStudioDockPanel = lazy(() =>
  import('@/features/workflow/WorkflowStudioDockPanel').then((mod) => ({
    default: mod.WorkflowStudioDockPanel,
  }))
);

export interface EmbeddedWorkflowStudioShellProps {
  embeddedStudio: PendingWorkflowStudioOpenDetail;
  workflowDefinitions: readonly WorkflowDefinitionSummary[];
  className?: string;
  onBackToTaskList: () => void;
}

export function EmbeddedWorkflowStudioShell({
  embeddedStudio,
  workflowDefinitions,
  className,
  onBackToTaskList,
}: EmbeddedWorkflowStudioShellProps) {
  const { t } = useTranslation('panels');
  const activeWf = embeddedStudio.definitionId
    ? workflowDefinitions.find((wf) => wf.id === embeddedStudio.definitionId)
    : null;

  return (
    <div
      data-testid="automation-embedded-workflow-studio"
      className={cn(
        'flex h-full min-h-0 flex-col bg-[var(--surface-panel)] text-foreground',
        className
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-[var(--surface-elevated)] px-3 py-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="embedded-studio-back-btn"
            onClick={onBackToTaskList}
          >
            {t('pulseDeck.workbench.actions.backToTaskList')}
          </Button>
          <span className="inline-flex items-center gap-1 rounded border border-primary/35 bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary">
            <GitFork className="h-3 w-3 shrink-0" />
            {t('pulseDeck.workbench.actions.embeddedStudioBadge')}
          </span>
          {activeWf || embeddedStudio.definitionId ? (
            <span className="truncate text-xs font-medium text-foreground">
              {activeWf?.name ?? embeddedStudio.definitionId}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
              {t('pulseDeck.workbench.actions.loadingStudio')}
            </div>
          }
        >
          <LazyWorkflowStudioDockPanel />
        </Suspense>
      </div>
    </div>
  );
}

export interface AutomationHeaderBarProps {
  engineActive: boolean;
  totalTasksCount: number;
  pendingEventsCount: number;
  connectedSourcesCount: number;
  activeTab: AutomationPrimaryTab;
  isRefreshing: boolean;
  errorMessage: string;
  onSelectTab: (tab: AutomationPrimaryTab) => void;
  onNewFastTask: () => void;
  onNewWorkflow: () => void;
  onRefresh: () => void;
  onRetryError: () => void;
}

export function AutomationHeaderBar({
  engineActive,
  totalTasksCount,
  pendingEventsCount,
  connectedSourcesCount,
  activeTab,
  isRefreshing,
  errorMessage,
  onSelectTab,
  onNewFastTask,
  onNewWorkflow,
  onRefresh,
  onRetryError,
}: AutomationHeaderBarProps) {
  const { t } = useTranslation('panels');

  const primaryTabs: Array<{
    id: AutomationPrimaryTab;
    label: string;
    badge?: number;
  }> = [
    {
      id: 'tasks',
      label: t('pulseDeck.workbench.primaryTabs.tasks'),
    },
    {
      id: 'pending',
      label: t('pulseDeck.workbench.primaryTabs.pending'),
      badge: pendingEventsCount > 0 ? pendingEventsCount : undefined,
    },
    {
      id: 'rules',
      label: t('pulseDeck.workbench.primaryTabs.rules'),
    },
    {
      id: 'sources',
      label: t('pulseDeck.workbench.primaryTabs.sources'),
    },
  ];

  return (
    <>
      <header className="shrink-0 border-b border-border bg-[var(--surface-elevated)] px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Activity className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold tracking-tight">
                {t('pulseDeck.title')}
              </h2>
            </div>

            <span
              data-testid="pulse-deck-engine-badge"
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium',
                engineActive
                  ? 'border-success/35 bg-success/10 text-foreground'
                  : 'border-border bg-[var(--surface-control)] text-muted-foreground'
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  engineActive ? 'bg-success' : 'bg-muted-foreground'
                )}
              />
              {engineActive
                ? t('pulseDeck.engineActive')
                : t('pulseDeck.enginePaused')}
            </span>

            <div className="hidden items-center gap-2 text-2xs tabular-nums text-muted-foreground sm:flex">
              <span>
                {t('pulseDeck.workbench.metrics.totalTasks')}{' '}
                <strong className="font-semibold text-foreground">
                  {totalTasksCount}
                </strong>
              </span>
              <span>·</span>
              <span>
                {t('pulseDeck.workbench.metrics.pendingEvents')}{' '}
                <strong className="font-semibold text-foreground">
                  {pendingEventsCount}
                </strong>
              </span>
              <span>·</span>
              <span>
                {t('pulseDeck.workbench.metrics.connectedSources')}{' '}
                <strong className="font-semibold text-foreground">
                  {connectedSourcesCount}
                </strong>
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              data-testid="automation-new-fasttask-btn"
              onClick={onNewFastTask}
              className="h-7 px-2.5 text-xs"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('pulseDeck.workbench.actions.newFastTask')}
            </Button>

            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="pulse-deck-open-workflow-studio"
              onClick={onNewWorkflow}
              className="h-7 px-2.5 text-xs"
            >
              <GitFork className="mr-1 h-3.5 w-3.5" />
              {t('pulseDeck.workbench.actions.newWorkflow')}
            </Button>

            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={t('pulseDeck.refreshAria')}
              data-testid="pulse-deck-refresh"
              onClick={onRefresh}
              className="h-7 px-2 text-xs"
            >
              <RefreshCw
                className={cn(
                  'mr-1 h-3.5 w-3.5',
                  isRefreshing && 'animate-spin'
                )}
              />
              {t('pulseDeck.workbench.actions.refresh')}
            </Button>
          </div>
        </div>

        <nav
          role="tablist"
          aria-label={t('pulseDeck.workbench.primaryTabs.aria')}
          className="mt-2 flex items-center gap-1 overflow-x-auto"
        >
          {primaryTabs.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`pulse-deck-tab-${tab.id}`}
                onClick={() => onSelectTab(tab.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-transparent bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
                )}
              >
                <span>{tab.label}</span>
                {tab.badge !== undefined ? (
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-0.2 text-2xs font-semibold tabular-nums',
                      active
                        ? 'bg-primary-foreground/20 text-primary-foreground'
                        : 'bg-warning/20 text-foreground'
                    )}
                  >
                    {tab.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
        >
          <span>{errorMessage}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onRetryError}
            className="h-6 px-2 text-2xs"
          >
            {t('pulseDeck.retry')}
          </Button>
        </div>
      ) : null}
    </>
  );
}
