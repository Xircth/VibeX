import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Popover } from '@astryxdesign/core/Popover';
import { Text } from '@astryxdesign/core/Text';
import { Loader2, Send, Sparkles } from 'lucide-react';

import { toast } from '@/components/ui/toast';
import { useManagedAgentOptions } from '@/features/agent-management';
import type { StudioWorkflowDefinition } from '@/features/workflow/WorkflowStudio';
import type { CollaborationBotOption } from '@/features/workflow/useCollaborationBotRoster';
import { resolveWorkflowAgentId } from '@/features/workflow/workflowAgent';
import type { PulseSourceView } from '@/lib/api/pulse';
import { cn } from '@/lib/utils';

import {
  CANONICAL_WORKFLOW_STARTERS,
  dispatchAutomationAgentRequest,
  type DispatchedAutomationAgentSession,
} from './automationAgentBridge';

export interface AutomationAgentComposerPopoverProps {
  mode: 'create' | 'edit_workflow';
  projectId?: string | null;
  workspaceId?: string | null;
  definitionId?: string | null;
  sourceRuleId?: string | null;
  currentDefinition?: StudioWorkflowDefinition | null;
  sources?: readonly PulseSourceView[];
  bots?: readonly CollaborationBotOption[];
  buttonLabel?: string;
  buttonVariant?: 'primary' | 'secondary' | 'ghost';
  buttonSize?: 'sm' | 'md' | 'lg';
  testId?: string;
  trigger?: ReactNode;
  onDispatched?: (session: DispatchedAutomationAgentSession) => void;
}

export function AutomationAgentComposerPopover({
  mode,
  projectId,
  workspaceId,
  definitionId,
  sourceRuleId,
  currentDefinition,
  sources,
  bots,
  buttonLabel,
  buttonVariant = 'primary',
  buttonSize = 'md',
  testId = 'automation-agent-composer-btn',
  trigger,
  onDispatched,
}: AutomationAgentComposerPopoverProps) {
  const { t, i18n } = useTranslation('panels');
  const agentOptions = useManagedAgentOptions(undefined, true);
  const defaultAgentId = resolveWorkflowAgentId(agentOptions, undefined);
  const [selectedAgentId, setSelectedAgentId] = useState(defaultAgentId);
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isZh = (i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN').startsWith(
    'zh'
  );

  const handleSubmit = async (overridePrompt?: string) => {
    const finalText = (overridePrompt ?? instruction).trim();
    if (!finalText || submitting) return;
    setSubmitting(true);
    try {
      const dispatched = await dispatchAutomationAgentRequest({
        mode,
        instruction: finalText,
        agentId: selectedAgentId || defaultAgentId,
        projectId,
        workspaceId,
        definitionId,
        sourceRuleId,
        currentDefinition,
        sources,
        agentOptions,
        bots,
      });
      setInstruction('');
      toast.success(
        t('pulseDeck.workbench.agent.dispatchedToast', {
          title: dispatched.title,
        })
      );
      onDispatched?.(dispatched);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const resolvedLabel =
    buttonLabel ??
    (mode === 'create'
      ? t('pulseDeck.workbench.agent.createBtn')
      : t('pulseDeck.workbench.agent.editBtn'));

  return (
    <Popover
      placement="below"
      alignment="end"
      width={400}
      label={resolvedLabel}
      content={
        <VStack gap={3}>
          <div className="flex flex-col gap-1">
            <Text type="body" weight="semibold">
              {mode === 'create'
                ? t('pulseDeck.workbench.agent.createPopoverTitle')
                : t('pulseDeck.workbench.agent.editPopoverTitle')}
            </Text>
            <Text type="supporting" color="secondary">
              {mode === 'create'
                ? t('pulseDeck.workbench.agent.createPopoverHint')
                : t('pulseDeck.workbench.agent.editPopoverHint')}
            </Text>
          </div>

          <textarea
            data-testid={`${testId}-input`}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                event.key === 'Enter' &&
                instruction.trim()
              ) {
                event.preventDefault();
                void handleSubmit();
              }
            }}
            rows={3}
            placeholder={
              mode === 'create'
                ? t('pulseDeck.workbench.agent.createPlaceholder')
                : t('pulseDeck.workbench.agent.editPlaceholder')
            }
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-xs leading-5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />

          {mode === 'create' ? (
            <div className="space-y-1.5">
              <Text type="supporting" color="secondary">
                {t('pulseDeck.workbench.agent.starterPromptsLabel')}
              </Text>
              <div className="flex flex-wrap gap-1.5">
                {CANONICAL_WORKFLOW_STARTERS.map((starter) => (
                  <button
                    key={starter.id}
                    type="button"
                    data-testid={`automation-starter-chip-${starter.id}`}
                    onClick={() =>
                      setInstruction(isZh ? starter.promptZh : starter.promptEn)
                    }
                    className="rounded-md border border-border bg-muted/50 px-2 py-1 text-left text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    {t(starter.titleKey)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <HStack gap={2} vAlign="center">
            {agentOptions.length > 0 ? (
              <select
                aria-label={t('pulseDeck.workbench.agent.selectAgentAria')}
                value={selectedAgentId}
                onChange={(event) => setSelectedAgentId(event.target.value)}
                className="h-8 max-w-[160px] truncate rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {agentOptions.map((agent) => (
                  <option key={agent.value} value={agent.value}>
                    {agent.label}
                  </option>
                ))}
              </select>
            ) : null}

            <div className="ml-auto flex items-center gap-2">
              <Button
                label={
                  submitting
                    ? t('pulseDeck.workbench.agent.sendingBtn')
                    : t('pulseDeck.workbench.agent.sendBtn')
                }
                variant="primary"
                size="sm"
                isDisabled={!instruction.trim() || submitting}
                data-testid={`${testId}-submit`}
                icon={
                  submitting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Icon icon={Send} size="xsm" />
                  )
                }
                onClick={() => void handleSubmit()}
              />
            </div>
          </HStack>
        </VStack>
      }
    >
      {trigger ? (
        <span>{trigger}</span>
      ) : (
        <Button
          label={resolvedLabel}
          variant={buttonVariant}
          size={buttonSize}
          data-testid={testId}
          icon={
            <Sparkles
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                buttonVariant === 'primary' ? 'text-current' : 'text-primary'
              )}
            />
          }
        />
      )}
    </Popover>
  );
}
