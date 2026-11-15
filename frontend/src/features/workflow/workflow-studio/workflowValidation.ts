import type { GateFilterAst } from '@/lib/api/pulse';

import type { StudioWorkflowDefinition, StudioWorkflowStep } from './types';

export type WorkflowValidationIssue = {
  path: string;
  code: string;
  message: string;
};

function validateGateFilter(
  filter: GateFilterAst | null | undefined,
  basePath: string,
  issues: WorkflowValidationIssue[]
) {
  if (!filter) return;
  filter.conditions.forEach((condition, condIndex) => {
    if (condition.op !== 'not_bot_actor' && !condition.pointer.trim()) {
      issues.push({
        path: `${basePath}.filter.conditions[${condIndex}].pointer`,
        code: 'empty_filter_pointer',
        message: 'Filter condition JSON Pointer cannot be empty.',
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
              : 'Invalid regular expression in filter condition.',
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
  basePath = `steps[${step.id || '?'}]`
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];

  if (!step.id || !step.id.trim()) {
    issues.push({
      path: `${basePath}.id`,
      code: 'empty_step_id',
      message: 'Step ID is required.',
    });
  }

  if (Array.isArray(step.dependsOn)) {
    step.dependsOn.forEach((dep, depIndex) => {
      if (dep === step.id) {
        issues.push({
          path: `${basePath}.dependsOn[${depIndex}]`,
          code: 'self_dependency',
          message: `Step "${step.id}" cannot depend on itself.`,
        });
      } else if (allStepIds && !allStepIds.has(dep)) {
        issues.push({
          path: `${basePath}.dependsOn[${depIndex}]`,
          code: 'unknown_dependency',
          message: `Dependency "${dep}" does not exist in this workflow.`,
        });
      }
    });
  }

  validateGateFilter(step.filter, basePath, issues);

  switch (step.kind) {
    case 'trigger': {
      if (!step.title.trim()) {
        issues.push({
          path: `${basePath}.title`,
          code: 'empty_trigger_title',
          message: 'Trigger title is required.',
        });
      }
      if (step.triggerKind === 'temporal') {
        if (!step.temporal) {
          issues.push({
            path: `${basePath}.temporal`,
            code: 'missing_temporal_spec',
            message: 'Temporal trigger requires a schedule specification.',
          });
        } else if (
          step.temporal.kind === 'cron' &&
          !step.temporal.expression.trim()
        ) {
          issues.push({
            path: `${basePath}.temporal.expression`,
            code: 'empty_cron_expression',
            message: 'Cron expression cannot be empty.',
          });
        } else if (
          step.temporal.kind === 'interval' &&
          step.temporal.everySeconds < 5
        ) {
          issues.push({
            path: `${basePath}.temporal.everySeconds`,
            code: 'interval_too_short',
            message: 'Temporal interval must be at least 5 seconds.',
          });
        } else if (
          step.temporal.kind === 'inactivity_sla' &&
          step.temporal.timeoutSeconds < 10
        ) {
          issues.push({
            path: `${basePath}.temporal.timeoutSeconds`,
            code: 'sla_too_short',
            message: 'Inactivity SLA timeout must be at least 10 seconds.',
          });
        }
      } else if (!step.eventType.trim()) {
        issues.push({
          path: `${basePath}.eventType`,
          code: 'empty_event_type',
          message: 'Trigger eventType is required.',
        });
      }
      validateGateFilter(step.filter, basePath, issues);
      break;
    }

    case 'session':
    case 'agent': {
      if (!step.agentId.trim()) {
        issues.push({
          path: `${basePath}.agentId`,
          code: 'missing_agent_id',
          message: 'Session step requires a target agentId.',
        });
      }
      if (!step.prompt.trim()) {
        issues.push({
          path: `${basePath}.prompt`,
          code: 'empty_prompt',
          message: 'Session step prompt cannot be empty.',
        });
      }
      break;
    }

    case 'bot': {
      if (!step.memberId.trim()) {
        issues.push({
          path: `${basePath}.memberId`,
          code: 'missing_bot_member_id',
          message: 'Bot step requires a bound memberId.',
        });
      }
      if (!step.prompt.trim()) {
        issues.push({
          path: `${basePath}.prompt`,
          code: 'empty_bot_prompt',
          message: 'Bot step prompt cannot be empty.',
        });
      }
      break;
    }

    case 'group_stage': {
      if (!step.spaceId.trim()) {
        issues.push({
          path: `${basePath}.spaceId`,
          code: 'missing_space_id',
          message: 'Group Stage requires a collaboration spaceId.',
        });
      }
      if (
        step.dispatchMode.type === 'specific_seat' &&
        !step.dispatchMode.memberId.trim()
      ) {
        issues.push({
          path: `${basePath}.dispatchMode.memberId`,
          code: 'missing_seat_member_id',
          message: 'Specific Seat dispatch requires a memberId.',
        });
      }
      if (
        step.dispatchMode.type === 'mention_seats' &&
        step.dispatchMode.memberIds.length === 0
      ) {
        issues.push({
          path: `${basePath}.dispatchMode.memberIds`,
          code: 'empty_mention_seats',
          message: 'Mention Seats dispatch requires at least one memberId.',
        });
      }
      if (
        step.dispatchMode.type === 'moderator_triage' &&
        !step.dispatchMode.moderatorMemberId.trim()
      ) {
        issues.push({
          path: `${basePath}.dispatchMode.moderatorMemberId`,
          code: 'missing_moderator_id',
          message: 'Moderator Triage dispatch requires a moderatorMemberId.',
        });
      }
      if (!step.prompt.trim()) {
        issues.push({
          path: `${basePath}.prompt`,
          code: 'empty_group_prompt',
          message: 'Group Stage message prompt is required.',
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
          message: 'User Gate title is required.',
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
          message: 'SLA timeout must be at least 10 seconds when specified.',
        });
      }
      break;
    }

    case 'control': {
      if (!step.title.trim()) {
        issues.push({
          path: `${basePath}.title`,
          code: 'empty_control_title',
          message: 'Control node title is required.',
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
            message:
              'BoundedLoop maxIterations must be an integer between 1 and 50 (1 <= maxIterations <= 50).',
          });
        }
      } else if (step.controlKind === 'condition') {
        if (!step.expression?.trim()) {
          issues.push({
            path: `${basePath}.expression`,
            code: 'empty_condition_expression',
            message: 'Condition node requires a non-empty branch expression.',
          });
        }
      } else if (step.controlKind === 'wait_for_event') {
        if (!step.waitEventType?.trim()) {
          issues.push({
            path: `${basePath}.waitEventType`,
            code: 'empty_wait_event_type',
            message: 'WaitForEvent node requires waitEventType.',
          });
        }
        if (!step.threadKeyTemplate?.trim()) {
          issues.push({
            path: `${basePath}.threadKeyTemplate`,
            code: 'empty_wait_thread_key',
            message:
              'WaitForEvent node requires a correlation threadKeyTemplate.',
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
          message: 'Outbox Action requires a target channel, URL, or event type.',
        });
      }
      if (!step.payloadTemplate.trim()) {
        issues.push({
          path: `${basePath}.payloadTemplate`,
          code: 'empty_outbox_template',
          message: 'Outbox Action payload/message template cannot be empty.',
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
  definition: StudioWorkflowDefinition
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];

  if (!definition.name || !definition.name.trim()) {
    issues.push({
      path: 'name',
      code: 'empty_workflow_name',
      message: 'Workflow name cannot be empty.',
    });
  }

  if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
    issues.push({
      path: 'steps',
      code: 'empty_steps',
      message: 'Workflow must contain at least one step.',
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
        message: `Duplicate step ID "${step.id}".`,
      });
    }
    seenIds.add(step.id);

    issues.push(...validateStudioStepExhaustively(step, allStepIds, basePath));
  });

  return issues;
}
