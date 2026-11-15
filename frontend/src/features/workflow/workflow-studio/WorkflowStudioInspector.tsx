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
import { MemberBotAvatar } from '@/features/collaboration/MemberBotAvatar';
import { cn } from '@/lib/utils';

import { WorkflowStepConversation } from '../WorkflowStepConversation';
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
    unsavedStepIds,
    selectedRun,
    activeWorktree,
    onPauseStep,
    onSubmitStepInput,
    onAcceptCandidate,
    agentOptions,
    bots,
    spaces,
    sources,
    projectId,
    definitionId,
    sourceRuleId,
    defaultAgentId,
    outputLanguage,
    onAgentDispatched,
  } = studio;

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
      toast.success(
        t('inspector.agentEdit.dispatchedToast', { title: dispatched.title })
      );
      onAgentDispatched?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDispatchingAgent(false);
    }
  };

  return (
    <aside
      ref={inspectorRef}
      data-testid="workflow-node-inspector"
      className="workflow-node-inspector absolute right-3 top-16 z-20 flex max-h-[calc(100%-76px)] w-[min(400px,calc(100%-24px))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-3.5 py-2.5">
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
            className="truncate text-sm font-semibold text-foreground"
            title={presentation.headline}
          >
            {presentation.headline}
          </span>
        </div>

        <div
          role="tablist"
          aria-label={t('inspector.tabs.overview')}
          className="flex shrink-0 items-center rounded-lg bg-muted/65 p-0.5"
        >
          {(['info', 'conversation'] as const).map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={inspectorTab === tab}
              key={tab}
              data-testid={`inspector-tab-${tab}`}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
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
                  const sibling = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
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
          className="size-7 shrink-0"
          onClick={() => setSelectedStepId(null)}
          aria-label={t('studio.close')}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div
        className={cn(
          'min-h-0 flex-1 p-3.5',
          inspectorTab === 'conversation' ? 'overflow-hidden' : 'overflow-auto'
        )}
      >
        {inspectorTab === 'conversation' ? (
          <WorkflowStepConversation
            stepRun={selectedRun}
            saved={!unsavedStepIds.has(selectedStep.id)}
            workspacePath={activeWorktree?.path}
            onPause={() => onPauseStep?.(selectedStep.id)}
            onSubmit={(text) => onSubmitStepInput?.(selectedStep.id, text)}
            onConfirm={
              selectedRun?.awaitingAcceptance
                ? () => onAcceptCandidate?.(selectedStep.id)
                : undefined
            }
          />
        ) : (
          <WorkflowStudioInspectorInfo
            selectedStep={selectedStep}
            studio={studio}
          />
        )}
      </div>

      {onDefinitionChange ? (
        <div className="border-t border-border/70 bg-muted/25 px-3.5 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Sparkles className="size-3 text-primary" />
            <span>{t('inspector.agentEdit.label')}</span>
          </div>
          <div className="flex items-center gap-1.5">
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
              className="h-8 flex-1 text-xs"
            />
            <Button
              type="button"
              size="icon"
              className="size-8 shrink-0"
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
