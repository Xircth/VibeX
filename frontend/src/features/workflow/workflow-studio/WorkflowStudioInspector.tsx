import { useState } from 'react';
import {
  GitFork,
  Loader2,
  MessageSquare,
  Send,
  Sparkles,
  X,
} from 'lucide-react';

import { dispatchAutomationAgentRequest } from '@/components/kanban/automation/automationAgentBridge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useOptionalKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { MemberBotAvatar } from '@/features/collaboration/MemberBotAvatar';
import { dismissCreateSessionOverlays } from '@/lib/requestCreateSession';
import { cn } from '@/lib/utils';
import { useLayoutStore } from '@/stores/useLayoutStore';

import { WorkflowStepExecutionRecords } from './WorkflowStepExecutionRecords';
import { StudioAgentIcon } from './StudioAgentIcon';
import type { WorkflowStudioView } from './useWorkflowStudio';
import { describeStepPresentation } from './workflowStepPresentation';
import { WorkflowStudioInspectorInfo } from './WorkflowStudioInspectorInfo';

export function WorkflowStudioInspector({
  studio,
}: {
  studio: WorkflowStudioView;
}) {
  const {
    selectedStep,
    inspectorRef,
    t,
    onDefinitionChange,
    definition,
    setSelectedStepId,
    inspectorTab,
    setInspectorTab,
    agentOptions,
    bots,
    sources,
    projectId,
    definitionId,
    sourceRuleId,
    defaultAgentId,
    outputLanguage,
    spaces,
    onAgentDispatched,
  } = studio;

  const kanbanSession = useOptionalKanbanSessionContext();
  const [agentInstruction, setAgentInstruction] = useState('');
  const [dispatchingAgent, setDispatchingAgent] = useState(false);

  if (!selectedStep) return null;

  const presentation = describeStepPresentation(
    selectedStep,
    agentOptions,
    t('studio.notify'),
    t,
    {
      bots,
      spaces,
      language: outputLanguage,
    }
  );

  const sessionOrAgentStep =
    selectedStep.kind === 'session' || selectedStep.kind === 'agent'
      ? selectedStep
      : null;

  const handleDispatchStepEdit = async () => {
    const trimmed = agentInstruction.trim();
    if (!trimmed || dispatchingAgent) return;
    setDispatchingAgent(true);
    try {
      const dispatched = await dispatchAutomationAgentRequest({
        mode: 'edit_step',
        instruction: trimmed,
        agentId: defaultAgentId,
        projectId,
        definitionId,
        sourceRuleId,
        targetStepId: selectedStep.id,
        currentDefinition: definition,
        sources,
        agentOptions,
        bots,
      });
      setAgentInstruction('');
      if (dispatched.sessionId && dispatched.workspaceId) {
        const layout = useLayoutStore.getState();
        if (layout.activeTab === 'kanban') {
          layout.setKanbanSessionVisible(true);
        } else {
          layout.setRightPanelVisible(true);
        }
        dismissCreateSessionOverlays();
        kanbanSession?.activateExecutionSession({
          sessionId: dispatched.sessionId,
          workspaceId: dispatched.workspaceId,
        });
      }
      toast.success(
        t('inspector.agentEdit.dispatchedToast', { title: dispatched.title })
      );
      onAgentDispatched?.();
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === 'object' &&
              error !== null &&
              'message' in error &&
              typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : String(error);
      toast.error(msg);
    } finally {
      setDispatchingAgent(false);
    }
  };

  return (
    <aside
      ref={inspectorRef}
      data-testid="workflow-node-inspector"
      className={cn(
        'workflow-node-inspector flex w-[400px] flex-col overflow-hidden rounded-[var(--radius-container)] border border-border bg-card shadow-xl',
        inspectorTab === 'conversation' ? 'h-[520px]' : 'max-h-[540px]'
      )}
    >
      <div className="workflow-inspector-drag-handle flex cursor-grab items-center gap-2 px-3.5 pt-3 pb-1.5 select-none active:cursor-grabbing">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {sessionOrAgentStep ? (
            <StudioAgentIcon
              agentId={sessionOrAgentStep.agentId}
              agentOptions={agentOptions}
              className="size-4 shrink-0"
            />
          ) : presentation.category === 'bot' && presentation.botAvatar ? (
            <MemberBotAvatar
              config={presentation.botAvatar}
              animated={false}
              className="size-4 shrink-0"
            />
          ) : null}
          <span
            data-testid="inspector-node-title"
            className="truncate text-[13px] font-semibold text-foreground"
            title={presentation.headline}
          >
            {presentation.headline}
          </span>
        </div>

        <div
          role="tablist"
          aria-label={t('inspector.tabs.overview')}
          className="nodrag nopan flex shrink-0 items-center rounded-[var(--radius-element)] bg-muted/65 p-0.5"
        >
          {(['info', 'conversation'] as const).map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={inspectorTab === tab}
              key={tab}
              data-testid={`inspector-tab-${tab}`}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-[var(--radius-inner)] px-2.5 text-xs font-medium transition-colors',
                inspectorTab === tab
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setInspectorTab(tab)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  event.preventDefault();
                  const nextTab = tab === 'info' ? 'conversation' : 'info';
                  setInspectorTab(nextTab);
                  const sibling =
                    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
                      `[data-testid="inspector-tab-${nextTab}"]`
                    );
                  sibling?.focus();
                }
              }}
            >
              {tab === 'info' ? (
                <GitFork className="size-3.5" />
              ) : (
                <MessageSquare className="size-3.5" />
              )}
              {tab === 'info'
                ? t('inspector.tabs.overview')
                : t('inspector.tabs.records')}
            </button>
          ))}
        </div>

        <Button
          size="icon"
          variant="ghost"
          className="nodrag nopan size-7 shrink-0"
          onClick={() => setSelectedStepId(null)}
          aria-label={t('studio.close')}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div
        className={cn(
          'nodrag nopan nowheel min-h-0 flex-1 select-text',
          inspectorTab === 'conversation'
            ? 'overflow-hidden px-2.5 py-1.5'
            : 'overflow-auto px-3.5 py-2'
        )}
      >
        {inspectorTab === 'conversation' ? (
          <WorkflowStepExecutionRecords
            selectedStep={selectedStep}
            studio={studio}
          />
        ) : (
          <WorkflowStudioInspectorInfo
            selectedStep={selectedStep}
            studio={studio}
          />
        )}
      </div>

      {onDefinitionChange && inspectorTab === 'info' ? (
        <div className="nodrag nopan nowheel px-3.5 pb-3 pt-1">
          <div className="flex items-center gap-1.5 rounded-[var(--radius-element)] bg-muted/45 p-1 pl-2.5">
            <Sparkles className="size-3.5 shrink-0 text-primary" />
            <Input
              data-testid="inspector-agent-step-input"
              value={agentInstruction}
              disabled={dispatchingAgent}
              onChange={(event) => setAgentInstruction(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void handleDispatchStepEdit();
                }
              }}
              placeholder={t('inspector.agentEdit.placeholder')}
              className="h-7 flex-1 border-transparent bg-transparent px-1 text-xs shadow-none focus-visible:border-transparent focus-visible:[box-shadow:none]"
            />
            <Button
              type="button"
              size="icon"
              className="size-7 shrink-0"
              data-testid="inspector-agent-step-submit"
              aria-label={t('inspector.agentEdit.submitAria')}
              disabled={!agentInstruction.trim() || dispatchingAgent}
              onClick={() => void handleDispatchStepEdit()}
            >
              {dispatchingAgent ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
