import { useMemo } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PulseFilterBuilder } from '@/features/pulse';
import type { BotMailboxPolicy, PulseRuleSpec } from '@/lib/api/pulse';

import { DEFAULT_GATE_FILTER, type StudioWorkflowStep } from './types';
import type { WorkflowStudioView } from './useWorkflowStudio';
import { formatWorkflowMailboxPolicy } from './workflowStepPresentation';

function buildDryRunRuleSpec(
  step: StudioWorkflowStep,
  defaultAgentId: string
): PulseRuleSpec {
  const filter = step.filter ?? DEFAULT_GATE_FILTER;
  switch (step.kind) {
    case 'session':
    case 'agent':
      return {
        name: step.id,
        evalMode: 'observe',
        filter,
        targets: [
          {
            kind: 'session',
            mode: step.subscribeThread ? 'thread_keyed' : 'ephemeral_fresh',
            agentId: step.agentId || defaultAgentId,
            promptTemplate: step.prompt || '{{event.type}} on {{threadKey}}',
          },
        ],
      };
    case 'bot':
      return {
        name: step.id,
        evalMode: 'observe',
        filter,
        targets: [
          {
            kind: 'bot',
            memberId: step.memberId || 'triage-bot',
            mailboxPolicy: step.mailboxPolicy,
            conversationScope: step.conversationScope,
            promptTemplate: step.prompt || '{{event.type}} on {{threadKey}}',
          },
        ],
      };
    case 'group_stage':
      return {
        name: step.id,
        evalMode: 'observe',
        filter,
        targets: [
          {
            kind: 'group',
            spaceId: step.spaceId || 'eng-council',
            dispatchMode: step.dispatchMode,
            messageTemplate: step.prompt || '{{event.type}}',
          },
        ],
      };
    case 'user_gate':
      return {
        name: step.id,
        evalMode: 'observe',
        filter,
        targets: [
          {
            kind: 'user',
            interactionKind: step.interactionKind,
            titleTemplate: step.title || step.id,
            bodyTemplate: step.bodyTemplate || '{{threadKey}}',
            slaTimeoutSeconds: step.slaTimeoutSeconds ?? null,
          },
        ],
      };
    case 'trigger':
      return {
        name: step.title || step.id,
        evalMode: step.evalMode,
        filter,
        temporal: step.temporal ?? null,
        targets: [
          {
            kind: 'session',
            mode: 'ephemeral_fresh',
            agentId: defaultAgentId,
            promptTemplate: 'Triggered {{event.type}} on {{threadKey}}',
          },
        ],
      };
    case 'outbox_action':
      return {
        name: step.title || step.id,
        evalMode: 'observe',
        filter,
        targets: [
          {
            kind: 'session',
            mode: 'ephemeral_fresh',
            agentId: defaultAgentId,
            promptTemplate: step.payloadTemplate || '{{threadKey}}',
          },
        ],
      };
    default:
      return {
        name: step.id,
        evalMode: 'observe',
        filter,
        targets: [
          {
            kind: 'user',
            interactionKind: step.kind === 'approval' ? 'approval' : 'notify',
            titleTemplate: 'title' in step && step.title ? step.title : step.id,
            bodyTemplate: '{{threadKey}}',
          },
        ],
      };
  }
}

export function WorkflowStudioInspectorAdvanced({
  selectedStep,
  studio,
}: {
  selectedStep: StudioWorkflowStep;
  studio: WorkflowStudioView;
}) {
  const {
    t,
    onDefinitionChange,
    updateStep,
    capturedEvents,
    defaultAgentId,
  } = studio;

  const effectiveFilter = selectedStep.filter ?? DEFAULT_GATE_FILTER;
  const dryRunRuleSpec = useMemo(
    () => buildDryRunRuleSpec(selectedStep, defaultAgentId),
    [defaultAgentId, selectedStep]
  );

  const showSlaField =
    selectedStep.kind === 'user_gate' ||
    selectedStep.kind === 'approval' ||
    selectedStep.kind === 'notify';

  return (
    <div className="space-y-4" data-testid="inspector-advanced-panel">
      <div className="space-y-2.5 rounded-lg border border-border bg-muted/25 p-3">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="advanced-subscribe-thread" className="text-xs">
            {t('inspector.advanced.subscribeThread')}
          </Label>
          <input
            id="advanced-subscribe-thread"
            type="checkbox"
            checked={Boolean(selectedStep.subscribeThread)}
            disabled={!onDefinitionChange}
            onChange={(event) =>
              updateStep(selectedStep.id, (step) => ({
                ...step,
                subscribeThread: event.target.checked,
              }))
            }
            className="size-4 accent-primary"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="advanced-thread-key" className="text-xs">
            {t('inspector.advanced.threadKey')}
          </Label>
          <Input
            id="advanced-thread-key"
            className="font-mono text-xs"
            placeholder="{{threadKey}}"
            value={selectedStep.threadKeyTemplate ?? ''}
            disabled={!onDefinitionChange}
            onChange={(event) =>
              updateStep(selectedStep.id, (step) => ({
                ...step,
                threadKeyTemplate: event.target.value,
              }))
            }
          />
          <p className="text-[11px] leading-4 text-muted-foreground">
            {t('inspector.advanced.threadKeyHint')}
          </p>
        </div>
      </div>

      {selectedStep.kind === 'bot' ? (
        <div className="space-y-1.5">
          <Label>{t('inspector.advanced.botMailboxPolicy')}</Label>
          <Select
            value={selectedStep.mailboxPolicy}
            disabled={!onDefinitionChange}
            onValueChange={(mailboxPolicy: BotMailboxPolicy) =>
              updateStep(selectedStep.id, (step) =>
                step.kind === 'bot' ? { ...step, mailboxPolicy } : step
              )
            }
          >
            <SelectTrigger>
              <SelectValue>
                {formatWorkflowMailboxPolicy(selectedStep.mailboxPolicy, t, true)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fifo_serial">
                {t('inspector.bot.mailboxOptions.fifo_serial_detail')}
              </SelectItem>
              <SelectItem value="coalesce_batch">
                {t('inspector.bot.mailboxOptions.coalesce_batch_detail')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {selectedStep.kind === 'control' &&
      selectedStep.controlKind === 'bounded_loop' ? (
        <div className="space-y-1.5">
          <Label htmlFor="advanced-bounded-loop-max">
            {t('inspector.advanced.boundedLoopMax')}
          </Label>
          <Input
            id="advanced-bounded-loop-max"
            type="number"
            min={1}
            max={50}
            className="tabular-nums"
            value={selectedStep.maxIterations ?? 3}
            disabled={!onDefinitionChange}
            onChange={(event) =>
              updateStep(selectedStep.id, (step) =>
                step.kind === 'control'
                  ? { ...step, maxIterations: Number(event.target.value) }
                  : step
              )
            }
          />
        </div>
      ) : null}

      {showSlaField ? (
        <div className="space-y-1.5">
          <Label htmlFor="advanced-sla-timeout">
            {t('inspector.advanced.slaTimeoutSeconds')}
          </Label>
          <Input
            id="advanced-sla-timeout"
            type="number"
            className="tabular-nums"
            placeholder={t('inspector.userGate.optionalMin10Placeholder')}
            value={selectedStep.slaTimeoutSeconds ?? ''}
            disabled={!onDefinitionChange}
            onChange={(event) =>
              updateStep(selectedStep.id, (step) =>
                step.kind === 'user_gate' ||
                step.kind === 'approval' ||
                step.kind === 'notify'
                  ? {
                      ...step,
                      slaTimeoutSeconds: event.target.value.trim()
                        ? Number(event.target.value)
                        : null,
                    }
                  : step
              )
            }
          />
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label>{t('inspector.advanced.gateFilterAndDryRun')}</Label>
        <PulseFilterBuilder
          filter={effectiveFilter}
          readOnly={!onDefinitionChange}
          ruleSpec={dryRunRuleSpec}
          sampleEvents={capturedEvents}
          showDryRun
          onChange={(nextFilter) =>
            updateStep(selectedStep.id, (step) => ({
              ...step,
              filter: nextFilter,
            }))
          }
        />
      </div>
    </div>
  );
}
