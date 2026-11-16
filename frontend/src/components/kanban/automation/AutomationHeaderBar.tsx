import { lazy, Suspense, type ReactNode, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner } from '@astryxdesign/core/Banner';
import { Text } from '@astryxdesign/core/Text';
import {
  PanelRight,
  RefreshCw,
  Sparkles,
  Webhook,
  Zap,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useLayoutStore } from '@/stores/useLayoutStore';

import type { AutomationPrimaryTab } from './automationModels';

const LazyWorkflowStudioDockPanel = lazy(() =>
  import('@/features/workflow/WorkflowStudioDockPanel').then((mod) => ({
    default: mod.WorkflowStudioDockPanel,
  }))
);

export interface EmbeddedWorkflowStudioShellProps {
  projectId?: string | null;
  className?: string;
  rootRef?: Ref<HTMLDivElement>;
  onBackToTaskList: () => void;
}

export function EmbeddedWorkflowStudioShell({
  projectId,
  className,
  rootRef,
  onBackToTaskList,
}: EmbeddedWorkflowStudioShellProps) {
  const { t } = useTranslation('panels');
  const isKanbanSessionVisible = useLayoutStore(
    (state) => state.isKanbanSessionVisible
  );
  const toggleKanbanSession = useLayoutStore(
    (state) => state.toggleKanbanSession
  );

  const sessionToggleSlot = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('pulseDeck.workbench.agent.toggleSidebarAria')}
          aria-pressed={isKanbanSessionVisible}
          data-testid="embedded-studio-toggle-session-sidebar-btn"
          onClick={toggleKanbanSession}
          className={cn(
            'h-7 w-7 shrink-0',
            isKanbanSessionVisible && 'bg-muted text-foreground'
          )}
        >
          <PanelRight className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {t('pulseDeck.workbench.agent.toggleSidebarAria')}
      </TooltipContent>
    </Tooltip>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div
        ref={rootRef}
        data-testid="automation-embedded-workflow-studio"
        className={cn(
          'pulse-automation-page flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground',
          className
        )}
      >
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center p-6">
              <Text type="supporting" color="secondary">
                {t('pulseDeck.workbench.actions.loadingStudio')}
              </Text>
            </div>
          }
        >
          <LazyWorkflowStudioDockPanel
            embedded
            projectId={projectId}
            onBack={onBackToTaskList}
            rightToolbarSlot={sessionToggleSlot}
          />
        </Suspense>
      </div>
    </TooltipProvider>
  );
}

export interface AutomationPageShellProps {
  totalTasksCount: number;
  pendingApprovalsCount: number;
  activeTab: AutomationPrimaryTab;
  isRefreshing: boolean;
  errorMessage: string;
  headerSearch?: ReactNode;
  contextualAction?: ReactNode;
  children: ReactNode;
  className?: string;
  rootRef?: Ref<HTMLDivElement>;
  onSelectTab: (tab: AutomationPrimaryTab) => void;
  onRefresh: () => void;
  onRetryError: () => void;
  onCreateWorkflowWithAgent: () => void;
}

export function AutomationPageShell({
  totalTasksCount,
  pendingApprovalsCount,
  activeTab,
  isRefreshing,
  errorMessage,
  headerSearch,
  contextualAction,
  children,
  className,
  rootRef,
  onSelectTab,
  onRefresh,
  onRetryError,
  onCreateWorkflowWithAgent,
}: AutomationPageShellProps) {
  const { t } = useTranslation('panels');
  const isKanbanSessionVisible = useLayoutStore(
    (state) => state.isKanbanSessionVisible
  );
  const toggleKanbanSession = useLayoutStore(
    (state) => state.toggleKanbanSession
  );

  const navItems: ReadonlyArray<{
    key: AutomationPrimaryTab;
    label: string;
    testId: string;
    icon: typeof Zap;
    badgeDot?: boolean;
    countSuffix?: string;
  }> = [
    {
      key: 'tasks',
      label: t('pulseDeck.workbench.primaryTabs.tasks'),
      testId: 'pulse-deck-tab-tasks',
      icon: Zap,
      badgeDot: pendingApprovalsCount > 0,
      countSuffix: totalTasksCount > 0 ? ` (${totalTasksCount})` : undefined,
    },
    {
      key: 'sources',
      label: t('pulseDeck.workbench.primaryTabs.sources'),
      testId: 'pulse-deck-tab-sources',
      icon: Webhook,
    },
  ];

  return (
    <TooltipProvider delayDuration={200}>
      <div
        ref={rootRef}
        data-testid="pulse-deck-view"
        className={cn(
          'kanban-usage-page pulse-automation-page flex h-full min-h-0 flex-1 flex-col overflow-hidden text-foreground',
          className
        )}
      >
        {/* Compact page header aligned 1:1 with KanbanUsageDashboard */}
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex h-8 items-center">
            <h2
              data-testid="pulse-deck-heading"
              className="m-0 text-base font-semibold leading-none text-foreground"
            >
              {t('pulseDeck.title')}
            </h2>
          </div>

          <div className="flex min-w-0 items-center gap-1.5">
            {contextualAction}
            {headerSearch}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('pulseDeck.refreshAria')}
                  data-testid="pulse-deck-refresh"
                  onClick={onRefresh}
                  disabled={isRefreshing}
                  className="h-7 w-7 shrink-0"
                >
                  <RefreshCw
                    className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('pulseDeck.refreshAria')}
              </TooltipContent>
            </Tooltip>

            <Button
              type="button"
              variant="default"
              size="sm"
              data-testid="automation-agent-create-btn"
              onClick={onCreateWorkflowWithAgent}
              className="h-7 shrink-0 gap-1 px-2.5 text-xs"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t('pulseDeck.workbench.agent.createBtn')}
            </Button>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('pulseDeck.workbench.agent.toggleSidebarAria')}
                  aria-pressed={isKanbanSessionVisible}
                  data-testid="automation-toggle-session-sidebar-btn"
                  onClick={toggleKanbanSession}
                  className={cn(
                    'h-7 w-7 shrink-0',
                    isKanbanSessionVisible && 'bg-muted text-foreground'
                  )}
                >
                  <PanelRight className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('pulseDeck.workbench.agent.toggleSidebarAria')}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Left floating navigation rail + main content area aligned 1:1 with KanbanUsageDashboard */}
        <div className="relative flex min-h-0 flex-1">
          <div className="absolute left-10 top-1/2 z-10 -translate-y-1/2">
            <div
              role="tablist"
              aria-orientation="vertical"
              aria-label={t('pulseDeck.workbench.primaryTabs.aria')}
              data-testid="automation-left-nav-rail"
              className="kanban-usage-tab-rail flex flex-col gap-1 px-1 py-2"
            >
              {navItems.map((item) => {
                const active = activeTab === item.key;
                return (
                  <Tooltip key={item.key}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-label={item.label}
                        title={item.label}
                        data-testid={item.testId}
                        className={cn(
                          'kanban-usage-tab relative flex items-center justify-center rounded-md px-2 py-3 transition-colors',
                          active && 'is-active'
                        )}
                        onClick={() => onSelectTab(item.key)}
                      >
                        <item.icon className="h-4 w-4" />
                        {item.badgeDot ? (
                          <span
                            aria-hidden="true"
                            className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warning"
                          />
                        ) : null}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <span className="tabular-nums">
                        {item.label}
                        {item.countSuffix ?? ''}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4 pl-24">
            {errorMessage ? (
              <Banner
                status="error"
                container="card"
                title={errorMessage}
                isDismissable
                endContent={
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={onRetryError}
                    className="h-6 px-2 text-[11px]"
                  >
                    {t('pulseDeck.retry')}
                  </Button>
                }
              />
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {children}
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

