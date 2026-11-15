import { lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutHeader,
  StackItem,
  VStack,
} from '@astryxdesign/core/Layout';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Heading, Text } from '@astryxdesign/core/Text';
import { ArrowLeft, GitFork, RefreshCw } from 'lucide-react';
import type { WorkflowDefinitionSummary } from 'shared/types';

import type { CollaborationBotOption } from '@/features/workflow/useCollaborationBotRoster';
import type { PulseSourceView } from '@/lib/api/pulse';
import { cn } from '@/lib/utils';

import type { PendingWorkflowStudioOpenDetail } from '../pulseDeckEvents';
import { AutomationAgentComposerPopover } from './AutomationAgentComposerPopover';
import type { DispatchedAutomationAgentSession } from './automationAgentBridge';
import type { AutomationPrimaryTab } from './automationModels';

const LazyWorkflowStudioDockPanel = lazy(() =>
  import('@/features/workflow/WorkflowStudioDockPanel').then((mod) => ({
    default: mod.WorkflowStudioDockPanel,
  }))
);

export interface EmbeddedWorkflowStudioShellProps {
  embeddedStudio: PendingWorkflowStudioOpenDetail;
  workflowDefinitions: readonly WorkflowDefinitionSummary[];
  projectId?: string | null;
  sources?: readonly PulseSourceView[];
  bots?: readonly CollaborationBotOption[];
  className?: string;
  onAgentDispatched?: (session: DispatchedAutomationAgentSession) => void;
  onBackToTaskList: () => void;
}

export function EmbeddedWorkflowStudioShell({
  embeddedStudio,
  workflowDefinitions,
  projectId,
  sources,
  bots,
  className,
  onAgentDispatched,
  onBackToTaskList,
}: EmbeddedWorkflowStudioShellProps) {
  const { t } = useTranslation('panels');
  const activeWf = embeddedStudio.definitionId
    ? workflowDefinitions.find((wf) => wf.id === embeddedStudio.definitionId)
    : null;
  const resolvedTitle =
    activeWf?.name ??
    embeddedStudio.initialDefinition?.name ??
    embeddedStudio.definitionId ??
    null;

  return (
    <div
      data-testid="automation-embedded-workflow-studio"
      className={cn(
        'flex h-full min-h-0 flex-col bg-background text-foreground',
        className
      )}
    >
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider padding={3}>
            <HStack gap={3} vAlign="center">
              <Button
                label={t('pulseDeck.workbench.actions.backToTaskList')}
                variant="secondary"
                size="sm"
                icon={<Icon icon={ArrowLeft} size="sm" />}
                data-testid="embedded-studio-back-btn"
                onClick={onBackToTaskList}
              />
              <Badge
                variant="purple"
                icon={<Icon icon={GitFork} size="xsm" />}
                label={t('pulseDeck.workbench.actions.embeddedStudioBadge')}
              />
              {resolvedTitle ? (
                <Text type="body" weight="semibold" maxLines={1}>
                  {resolvedTitle}
                </Text>
              ) : null}
              <div className="ml-auto flex items-center gap-2">
                <AutomationAgentComposerPopover
                  mode="edit_workflow"
                  projectId={projectId}
                  definitionId={embeddedStudio.definitionId ?? null}
                  sourceRuleId={embeddedStudio.sourceRuleId ?? null}
                  currentDefinition={embeddedStudio.initialDefinition ?? null}
                  sources={sources}
                  bots={bots}
                  buttonVariant="secondary"
                  buttonSize="sm"
                  testId="embedded-studio-agent-edit-btn"
                  onDispatched={onAgentDispatched}
                />
              </div>
            </HStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={0}>
            <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center p-6">
                    <Text type="supporting" color="secondary">
                      {t('pulseDeck.workbench.actions.loadingStudio')}
                    </Text>
                  </div>
                }
              >
                <LazyWorkflowStudioDockPanel embedded projectId={projectId} />
              </Suspense>
            </div>
          </LayoutContent>
        }
      />
    </div>
  );
}

export interface AutomationHeaderBarProps {
  engineActive: boolean;
  totalTasksCount: number;
  pendingApprovalsCount: number;
  activeTab: AutomationPrimaryTab;
  isRefreshing: boolean;
  errorMessage: string;
  projectId?: string | null;
  sources?: readonly PulseSourceView[];
  bots?: readonly CollaborationBotOption[];
  toolbarRow?: ReactNode;
  contextualAction?: ReactNode;
  onSelectTab: (tab: AutomationPrimaryTab) => void;
  onAgentDispatched?: (session: DispatchedAutomationAgentSession) => void;
  onRefresh: () => void;
  onRetryError: () => void;
}

export function AutomationHeaderBar({
  engineActive,
  totalTasksCount,
  pendingApprovalsCount,
  activeTab,
  isRefreshing,
  errorMessage,
  projectId,
  sources,
  bots,
  toolbarRow,
  contextualAction,
  onSelectTab,
  onAgentDispatched,
  onRefresh,
  onRetryError,
}: AutomationHeaderBarProps) {
  const { t } = useTranslation('panels');
  const engineLabel = engineActive
    ? t('pulseDeck.engineActive')
    : t('pulseDeck.enginePaused');

  return (
    <LayoutHeader hasDivider padding={4}>
      <VStack gap={4}>
        <HStack gap={3} vAlign="center">
          <HStack gap={2} vAlign="center">
            <Heading level={2}>{t('pulseDeck.title')}</Heading>
            <HStack
              gap={1.5}
              vAlign="center"
              data-testid="pulse-deck-engine-badge"
            >
              <StatusDot
                variant={engineActive ? 'success' : 'neutral'}
                label={engineLabel}
                isPulsing={engineActive}
              />
              <Text type="supporting" color="secondary">
                {engineLabel}
              </Text>
            </HStack>
          </HStack>

          <span
            aria-hidden="true"
            className="mx-1 h-4 w-px shrink-0 bg-border/70"
          />

          <StackItem size="fill">
            <TabList
              value={activeTab}
              onChange={(val) => onSelectTab(val as AutomationPrimaryTab)}
              size="md"
              hasDivider={false}
              aria-label={t('pulseDeck.workbench.primaryTabs.aria')}
            >
              <Tab
                value="tasks"
                label={t('pulseDeck.workbench.primaryTabs.tasks')}
                data-testid="pulse-deck-tab-tasks"
                endContent={
                  <HStack gap={1} vAlign="center">
                    <Badge
                      variant="neutral"
                      label={String(totalTasksCount)}
                      className="tabular-nums"
                    />
                    {pendingApprovalsCount > 0 ? (
                      <Badge
                        variant="warning"
                        label={String(pendingApprovalsCount)}
                        className="tabular-nums"
                      />
                    ) : null}
                  </HStack>
                }
              />
              <Tab
                value="sources"
                label={t('pulseDeck.workbench.primaryTabs.sources')}
                data-testid="pulse-deck-tab-sources"
              />
            </TabList>
          </StackItem>

          <HStack gap={2} vAlign="center">
            {contextualAction}
            <Button
              label={t('pulseDeck.refreshAria')}
              variant="ghost"
              size="md"
              isIconOnly
              data-testid="pulse-deck-refresh"
              onClick={onRefresh}
              icon={
                <RefreshCw
                  className={cn('h-4 w-4', isRefreshing && 'animate-spin')}
                />
              }
            />
            <AutomationAgentComposerPopover
              mode="create"
              projectId={projectId}
              sources={sources}
              bots={bots}
              buttonSize="md"
              testId="automation-agent-create-btn"
              onDispatched={onAgentDispatched}
            />
          </HStack>
        </HStack>

        {toolbarRow}

        {errorMessage ? (
          <Banner
            status="error"
            container="card"
            title={errorMessage}
            isDismissable
            endContent={
              <Button
                label={t('pulseDeck.retry')}
                variant="ghost"
                size="sm"
                onClick={onRetryError}
              />
            }
          />
        ) : null}
      </VStack>
    </LayoutHeader>
  );
}
