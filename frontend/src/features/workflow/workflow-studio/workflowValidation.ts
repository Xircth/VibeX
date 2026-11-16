import type { GateFilterAst } from '@/lib/api/pulse';

import type { StudioWorkflowDefinition, StudioWorkflowStep } from './types';
import {
  getWorkflowTranslator,
  type WorkflowTranslateFn,
} from './workflowStepPresentation';

export type WorkflowValidationIssue = {
  path: string;
  code: string;
  message: string;
};

function validateGateFilter(
  filter: GateFilterAst | null | undefined,
  basePath: string,
  issues: WorkflowValidationIssue[],
  tr: WorkflowTranslateFn
) {
  if (!filter) return;
  filter.conditions.forEach((condition, condIndex) => {
    if (condition.op !== 'not_bot_actor' && !condition.pointer.trim()) {
      issues.push({
        path: `${basePath}.filter.conditions[${condIndex}].pointer`,
        code: 'empty_filter_pointer',
        message: tr('validation.emptyFilterPointer'),
      });
    }
    if (condition.op === 'regex') {
      try {
        new RegExp(condition.pattern);
      } catch (error) {
        issues.push({
          path: `${basePath}.filter.conditions[${condIndex}].pattern`,
          code: 'invalid_filter_regex',
          message:
            error instanceof Error
              ? error.message
              : tr('validation.invalidFilterRegex'),
        });
      }
    }
  });
}

/**
 * Exhaustively validates a single StudioWorkflowStep without short-circuiting.
 */
export function validateStudioStepExhaustively(
  step: StudioWorkflowStep,
  allStepIds?: ReadonlySet<string>,
  basePath = `steps[${step.id || '?'}]`,
  t?: WorkflowTranslateFn
): WorkflowValidationIssue[] {
  const tr = getWorkflowTranslator(t);
  const issues: WorkflowValidationIssue[] = [];

  if (!step.id || !step.id.trim()) {
    issues.push({
      path: `${basePath}.id`,
      code: 'empty_step_id',
      message: tr('validation.emptyStepId'),
    });
  }

  if (Array.isArray(step.dependsOn)) {
    step.dependsOn.forEach((dep, depIndex) => {
      if (dep === step.id) {
        issues.push({
          path: `${basePath}.dependsOn[${depIndex}]`,
          code: 'self_dependency',
          message: tr('validation.selfDependency', { id: step.id }),
        });
      } else if (allStepIds && !allStepIds.has(dep)) {
        issues.push({
          path: `${basePath}.dependsOn[${depIndex}]`,
          code: 'unknown_dependency',
          message: tr('validation.unknownDependency', { dep }),
        });
      }
    });
  }

  validateGateFilter(step.filter, basePath, issues, tr);

  switch (step.kind) {
    case 'trigger': {
      if (!step.title.trim()) {
        issues.push({
          path: `${basePath}.title`,
          code: 'empty_trigger_title',
          message: tr('validation.emptyTriggerTitle'),
        });
      }
      if (step.triggerKind === 'temporal') {
        if (!step.temporal) {
          issues.push({
            path: `${basePath}.temporal`,
            code: 'missing_temporal_spec',
            message: tr('validation.missingTemporalSpec'),
          });
        } else if (
          step.temporal.kind === 'cron' &&
          !step.temporal.expression.trim()
        ) {
          issues.push({
            path: `${basePath}.temporal.expression`,
            code: 'empty_cron_expression',
            message: tr('validation.emptyCronExpression'),
          });
        } else if (
          step.temporal.kind === 'interval' &&
          step.temporal.everySeconds < 5
        ) {
          issues.push({
            path: `${basePath}.temporal.everySeconds`,
            code: 'interval_too_short',
            message: tr('validation.intervalTooShort'),
          });
        } else if (
          step.temporal.kind === 'inactivity_sla' &&
          step.temporal.timeoutSeconds < 10
        ) {
          issues.push({
            path: `${basePath}.temporal.timeoutSeconds`,
            code: 'sla_too_short',
            message: tr('validation.slaTooShort'),
          });
        }
      } else if (!step.eventType.trim()) {
        issues.push({
          path: `${basePath}.eventType`,
          code: 'empty_event_type',
          message: tr('validation.emptyEventType'),
        });
      }
      validateGateFilter(step.filter, basePath, issues, tr);
      break;
    }

    case 'session':
    case 'agent': {
      if (!step.agentId.trim()) {
        issues.push({
          path: `${basePath}.agentId`,
          code: 'missing_agent_id',
          message: tr('validation.missingAgentId'),
        });
      }
      if (!step.prompt.trim()) {
        issues.push({
          path: `${basePath}.prompt`,
          code: 'empty_prompt',
          message: tr('validation.emptyPrompt'),
        });
      }
      break;
    }

    case 'bot': {
      if (!step.memberId.trim()) {
        issues.push({
          path: `${basePath}.memberId`,
          code: 'missing_bot_member_id',
          message: tr('validation.missingBotMemberId'),
        });
      }
      if (!step.prompt.trim()) {
        issues.push({
          path: `${basePath}.prompt`,
          code: 'empty_bot_prompt',
          message: tr('validation.emptyBotPrompt'),
        });
      }
      break;
    }

    case 'group_stage': {
      if (!step.spaceId.trim()) {
        issues.push({
          path: `${basePath}.spaceId`,
          code: 'missing_space_id',
          message: tr('validation.missingSpaceId'),
        });
      }
      if (
        step.dispatchMode.type === 'specific_seat' &&
        !step.dispatchMode.memberId.trim()
      ) {
        issues.push({
          path: `${basePath}.dispatchMode.memberId`,
          code: 'missing_seat_member_id',
          message: tr('validation.missingSeatMemberId'),
        });
      }
      if (
        step.dispatchMode.type === 'mention_seats' &&
        step.dispatchMode.memberIds.length === 0
      ) {
        issues.push({
          path: `${basePath}.dispatchMode.memberIds`,
          code: 'empty_mention_seats',
          message: tr('validation.emptyMentionSeats'),
        });
      }
      if (
        step.dispatchMode.type === 'moderator_triage' &&
        !step.dispatchMode.moderatorMemberId.trim()
      ) {
        issues.push({
          path: `${basePath}.dispatchMode.moderatorMemberId`,
          code: 'missing_moderator_id',
          message: tr('validation.missingModeratorId'),
        });
      }
      if (!step.prompt.trim()) {
        issues.push({
          path: `${basePath}.prompt`,
          code: 'empty_group_prompt',
          message: tr('validation.emptyGroupPrompt'),
        });
      }
      break;
    }

    case 'user_gate':
    case 'approval':
    case 'notify': {
      if (!step.title.trim()) {
        issues.push({
          path: `${basePath}.title`,
          code: 'empty_gate_title',
          message: tr('validation.emptyGateTitle'),
        });
      }
      if (
        step.slaTimeoutSeconds !== undefined &&
        step.slaTimeoutSeconds !== null &&
        step.slaTimeoutSeconds < 10
      ) {
        issues.push({
          path: `${basePath}.slaTimeoutSeconds`,
          code: 'invalid_sla_timeout',
          message: tr('validation.invalidSlaTimeout'),
        });
      }
      break;
    }

    case 'control': {
      if (!step.title.trim()) {
        issues.push({
          path: `${basePath}.title`,
          code: 'empty_control_title',
          message: tr('validation.emptyControlTitle'),
        });
      }
      if (step.controlKind === 'bounded_loop') {
        const maxIterations = step.maxIterations;
        if (
          typeof maxIterations !== 'number' ||
          !Number.isInteger(maxIterations) ||
          maxIterations < 1 ||
          maxIterations > 50
        ) {
          issues.push({
            path: `${basePath}.maxIterations`,
            code: 'invalid_bounded_loop_max_iterations',
            message: tr('validation.invalidBoundedLoopMaxIterations'),
          });
        }
      } else if (step.controlKind === 'condition') {
        if (!step.expression?.trim()) {
          issues.push({
            path: `${basePath}.expression`,
            code: 'empty_condition_expression',
            message: tr('validation.emptyConditionExpression'),
          });
        }
      } else if (step.controlKind === 'wait_for_event') {
        if (!step.waitEventType?.trim()) {
          issues.push({
            path: `${basePath}.waitEventType`,
            code: 'empty_wait_event_type',
            message: tr('validation.emptyWaitEventType'),
          });
        }
        if (!step.threadKeyTemplate?.trim()) {
          issues.push({
            path: `${basePath}.threadKeyTemplate`,
            code: 'empty_wait_thread_key',
            message: tr('validation.emptyWaitThreadKey'),
          });
        }
      }
      break;
    }

    case 'outbox_action': {
      if (!step.destination.trim()) {
        issues.push({
          path: `${basePath}.destination`,
          code: 'empty_outbox_destination',
          message: tr('validation.emptyOutboxDestination'),
        });
      }
      if (!step.payloadTemplate.trim()) {
        issues.push({
          path: `${basePath}.payloadTemplate`,
          code: 'empty_outbox_template',
          message: tr('validation.emptyOutboxTemplate'),
        });
      }
      break;
    }
  }

  return issues;
}

/**
 * Exhaustively validates an entire StudioWorkflowDefinition in a single pass (No Fail-Fast).
 */
export function validateStudioWorkflowExhaustively(
  definition: StudioWorkflowDefinition,
  t?: WorkflowTranslateFn
): WorkflowValidationIssue[] {
  const tr = getWorkflowTranslator(t);
  const issues: WorkflowValidationIssue[] = [];

  if (!definition.name || !definition.name.trim()) {
    issues.push({
      path: 'name',
      code: 'empty_workflow_name',
      message: tr('validation.emptyWorkflowName'),
    });
  }

  if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
    issues.push({
      path: 'steps',
      code: 'empty_steps',
      message: tr('validation.emptySteps'),
    });
    return issues;
  }

  const seenIds = new Set<string>();
  const allStepIds = new Set(definition.steps.map((step) => step.id));

  definition.steps.forEach((step, index) => {
    const basePath = `steps[${index}]`;
    if (seenIds.has(step.id)) {
      issues.push({
        path: `${basePath}.id`,
        code: 'duplicate_step_id',
        message: tr('validation.duplicateStepId', { id: step.id }),
      });
    }
    seenIds.add(step.id);

    issues.push(
      ...validateStudioStepExhaustively(step, allStepIds, basePath, tr)
    );
  });

  return issues;
}
