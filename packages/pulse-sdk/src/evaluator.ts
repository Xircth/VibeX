import type {
  EventEnvelope,
  GateFilterAst,
  GateFilterCondition,
  PulseDryRunReport,
  PulseDryRunViolation,
  PulseRuleSpec,
  PulseWorkflowDefinition,
  PulseWorkflowStep,
} from './types.ts';

export const MAX_GATE_FILTER_CONDITIONS = 128;
export const MAX_HOP_COUNT = 5;
export const MAX_BOUNDED_LOOP_ITERATIONS = 50;

/**
 * Resolves an RFC 6901 JSON Pointer (e.g. "/issue/priority" or "payload/issue/priority")
 * against an EventEnvelope or its payload.
 */
export function resolveJsonPointer(root: unknown, pointer: string): unknown {
  if (!pointer || pointer === '/') {
    return root;
  }
  const normalized = pointer.startsWith('/') ? pointer.slice(1) : pointer;
  const segments = normalized
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
        return undefined;
      }
      current = current[idx];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function evaluateGateCondition(
  condition: GateFilterCondition,
  envelope: EventEnvelope
): boolean {
  if (condition.op === 'not_bot_actor') {
    return !envelope.actor.isBot && !envelope.actor.isSelf;
  }

  const candidateFromPayload = resolveJsonPointer(
    envelope.payload,
    condition.pointer
  );
  const actual =
    candidateFromPayload !== undefined
      ? candidateFromPayload
      : resolveJsonPointer(envelope, condition.pointer);

  switch (condition.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'eq':
      return JSON.stringify(actual) === JSON.stringify(condition.value);
    case 'neq':
      return JSON.stringify(actual) !== JSON.stringify(condition.value);
    case 'lt':
      return typeof actual === 'number' && actual < condition.value;
    case 'lte':
      return typeof actual === 'number' && actual <= condition.value;
    case 'gt':
      return typeof actual === 'number' && actual > condition.value;
    case 'gte':
      return typeof actual === 'number' && actual >= condition.value;
    case 'contains':
      if (typeof actual === 'string') {
        return actual.includes(condition.needle);
      }
      if (Array.isArray(actual)) {
        return actual.some((item) => String(item) === condition.needle);
      }
      return false;
    case 'in_set':
      return condition.values.some(
        (val) => JSON.stringify(val) === JSON.stringify(actual)
      );
    case 'regex':
      if (typeof actual !== 'string') {
        return false;
      }
      try {
        return new RegExp(condition.pattern).test(actual);
      } catch {
        return false;
      }
  }
}

/**
 * Exhaustively validates a PulseRuleSpec in a single pass (No Fail-Fast).
 */
export function validatePulseRuleSpec(
  spec: PulseRuleSpec
): PulseDryRunViolation[] {
  const violations: PulseDryRunViolation[] = [];

  if (!spec.name || !spec.name.trim()) {
    violations.push({
      path: 'name',
      code: 'empty_name',
      message: 'Rule name is required.',
    });
  }

  if (
    spec.evalMode !== 'off' &&
    spec.evalMode !== 'observe' &&
    spec.evalMode !== 'auto'
  ) {
    violations.push({
      path: 'evalMode',
      code: 'invalid_eval_mode',
      message: "evalMode must be 'off', 'observe', or 'auto'.",
    });
  }

  if (spec.debounceMs !== undefined && spec.debounceMs < 0) {
    violations.push({
      path: 'debounceMs',
      code: 'negative_debounce',
      message: 'debounceMs must be >= 0.',
    });
  }

  if (!Array.isArray(spec.targets) || spec.targets.length === 0) {
    violations.push({
      path: 'targets',
      code: 'empty_targets',
      message: 'At least one target is required.',
    });
  }

  if (spec.filter.conditions.length > MAX_GATE_FILTER_CONDITIONS) {
    violations.push({
      path: 'filter.conditions',
      code: 'too_many_conditions',
      message: `Filter conditions exceed limit of ${MAX_GATE_FILTER_CONDITIONS}.`,
    });
  }

  spec.filter.conditions.forEach((condition, index) => {
    if (condition.op !== 'not_bot_actor') {
      const trimmed = condition.pointer.trim();
      if (!trimmed) {
        violations.push({
          path: `filter.conditions[${index}].pointer`,
          code: 'empty_pointer',
          message: 'JSON Pointer cannot be empty.',
        });
      } else if (!trimmed.startsWith('/')) {
        violations.push({
          path: `filter.conditions[${index}].pointer`,
          code: 'invalid_pointer_prefix',
          message: "RFC 6901 JSON Pointer must start with '/'.",
        });
      }
    }
    if (condition.op === 'regex') {
      if (!condition.pattern) {
        violations.push({
          path: `filter.conditions[${index}].pattern`,
          code: 'empty_regex_pattern',
          message: 'Regex pattern cannot be empty.',
        });
      } else {
        try {
          new RegExp(condition.pattern);
        } catch (err) {
          violations.push({
            path: `filter.conditions[${index}].pattern`,
            code: 'invalid_regex',
            message:
              err instanceof Error
                ? err.message
                : 'Invalid regular expression.',
          });
        }
      }
    }
    if (condition.op === 'in_set' && condition.values.length === 0) {
      violations.push({
        path: `filter.conditions[${index}].values`,
        code: 'empty_in_set_values',
        message: 'in_set requires at least one candidate value.',
      });
    }
  });

  if (spec.temporal) {
    switch (spec.temporal.kind) {
      case 'cron': {
        const expr = spec.temporal.expression.trim();
        const fields = expr ? expr.split(/\s+/) : [];
        if (!expr) {
          violations.push({
            path: 'temporal.expression',
            code: 'empty_cron',
            message: 'Cron expression is required.',
          });
        } else if (fields.length < 5 || fields.length > 6) {
          violations.push({
            path: 'temporal.expression',
            code: 'invalid_cron_fields',
            message: 'Cron expression must have 5 or 6 whitespace-separated fields.',
          });
        }
        if (!spec.temporal.timezone.trim()) {
          violations.push({
            path: 'temporal.timezone',
            code: 'empty_timezone',
            message: 'IANA timezone is required for cron schedules.',
          });
        }
        break;
      }
      case 'once':
        if (!spec.temporal.fireAt.trim() || Number.isNaN(Date.parse(spec.temporal.fireAt))) {
          violations.push({
            path: 'temporal.fireAt',
            code: 'invalid_fire_at',
            message: 'fireAt must be a valid ISO-8601 timestamp.',
          });
        }
        break;
      case 'interval':
        if (spec.temporal.everySeconds < 5) {
          violations.push({
            path: 'temporal.everySeconds',
            code: 'interval_too_short',
            message: 'Interval must be at least 5 seconds.',
          });
        }
        break;
      case 'inactivity_sla':
        if (!spec.temporal.threadKeyPrefix.trim()) {
          violations.push({
            path: 'temporal.threadKeyPrefix',
            code: 'empty_thread_key_prefix',
            message: 'threadKeyPrefix is required for inactivity_sla.',
          });
        }
        if (spec.temporal.timeoutSeconds < 10) {
          violations.push({
            path: 'temporal.timeoutSeconds',
            code: 'sla_timeout_too_short',
            message: 'SLA timeout must be at least 10 seconds.',
          });
        }
        break;
    }
  }

  spec.targets.forEach((target, index) => {
    const base = `targets[${index}]`;
    switch (target.kind) {
      case 'session':
        if (!target.agentId.trim()) {
          violations.push({
            path: `${base}.agentId`,
            code: 'missing_agent_id',
            message: 'Session target requires an agentId.',
          });
        }
        if (
          target.mode === 'existing_session' &&
          !target.existingSessionId?.trim()
        ) {
          violations.push({
            path: `${base}.existingSessionId`,
            code: 'missing_existing_session_id',
            message: 'Existing session mode requires existingSessionId.',
          });
        }
        if (!target.promptTemplate.trim()) {
          violations.push({
            path: `${base}.promptTemplate`,
            code: 'empty_prompt_template',
            message: 'Prompt template is required.',
          });
        }
        break;
      case 'bot':
        if (!target.memberId.trim()) {
          violations.push({
            path: `${base}.memberId`,
            code: 'missing_member_id',
            message: 'Bot target requires a memberId.',
          });
        }
        if (!target.promptTemplate.trim()) {
          violations.push({
            path: `${base}.promptTemplate`,
            code: 'empty_prompt_template',
            message: 'Prompt template is required.',
          });
        }
        break;
      case 'group':
        if (!target.spaceId.trim()) {
          violations.push({
            path: `${base}.spaceId`,
            code: 'missing_space_id',
            message: 'Group target requires a spaceId.',
          });
        }
        if (
          target.dispatchMode.type === 'specific_seat' &&
          !target.dispatchMode.memberId.trim()
        ) {
          violations.push({
            path: `${base}.dispatchMode.memberId`,
            code: 'missing_seat_member_id',
            message: 'specific_seat dispatch requires a memberId.',
          });
        }
        if (
          target.dispatchMode.type === 'mention_seats' &&
          target.dispatchMode.memberIds.length === 0
        ) {
          violations.push({
            path: `${base}.dispatchMode.memberIds`,
            code: 'empty_mention_seats',
            message: 'mention_seats dispatch requires at least one memberId.',
          });
        }
        if (
          target.dispatchMode.type === 'moderator_triage' &&
          !target.dispatchMode.moderatorMemberId.trim()
        ) {
          violations.push({
            path: `${base}.dispatchMode.moderatorMemberId`,
            code: 'missing_moderator_member_id',
            message: 'moderator_triage dispatch requires moderatorMemberId.',
          });
        }
        if (!target.messageTemplate.trim()) {
          violations.push({
            path: `${base}.messageTemplate`,
            code: 'empty_message_template',
            message: 'Message template is required.',
          });
        }
        break;
      case 'user':
        if (!target.titleTemplate.trim()) {
          violations.push({
            path: `${base}.titleTemplate`,
            code: 'empty_title_template',
            message: 'Title template is required.',
          });
        }
        if (
          target.interactionKind === 'approval' &&
          (!target.approvalOptions || target.approvalOptions.length === 0)
        ) {
          violations.push({
            path: `${base}.approvalOptions`,
            code: 'empty_approval_options',
            message: 'Approval user target requires at least one approval option.',
          });
        }
        break;
      case 'workflow':
        if (!target.workflowId.trim()) {
          violations.push({
            path: `${base}.workflowId`,
            code: 'missing_workflow_id',
            message: 'Workflow target requires a workflowId.',
          });
        }
        if (!Number.isInteger(target.pinnedVersion) || target.pinnedVersion < 1) {
          violations.push({
            path: `${base}.pinnedVersion`,
            code: 'invalid_pinned_version',
            message: 'Workflow target requires pinnedVersion >= 1.',
          });
        }
        break;
    }
  });

  return violations;
}

export function renderPulseTemplate(
  template: string,
  envelope: EventEnvelope
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey) => {
    const key = String(rawKey).trim();
    if (key === 'event.id' || key === 'eventId') return envelope.eventId;
    if (key === 'event.type' || key === 'eventType') return envelope.eventType;
    if (key === 'actor.id') return envelope.actor.id;
    if (key === 'actor.displayName') {
      return envelope.actor.displayName ?? envelope.actor.id;
    }
    if (key === 'threadKey') return envelope.threadKey ?? '';
    const pointer = key.startsWith('/')
      ? key
      : `/${key.replace(/^payload\./, '').replace(/\./g, '/')}`;
    const resolved =
      resolveJsonPointer(envelope.payload, pointer) ??
      resolveJsonPointer(envelope, pointer);
    if (resolved === undefined || resolved === null) return '';
    return typeof resolved === 'object'
      ? JSON.stringify(resolved)
      : String(resolved);
  });
}

export function evaluatePulseRuleLocally(
  spec: PulseRuleSpec,
  envelope: EventEnvelope
): PulseDryRunReport {
  const violations = validatePulseRuleSpec(spec);
  const filter: GateFilterAst = spec.filter;
  const unmatchedConditions: number[] = [];

  if (envelope.actor.isSelf || envelope.trace.hopCount > MAX_HOP_COUNT) {
    return {
      valid: violations.length === 0,
      matched: false,
      violations,
      unmatchedConditions: [-1],
      renderedPreviews: [],
    };
  }

  const headerMatched =
    (filter.sourceKinds.length === 0 ||
      filter.sourceKinds.includes(envelope.source.kind)) &&
    (filter.sourceInstanceIds.length === 0 ||
      filter.sourceInstanceIds.includes(envelope.source.instanceId)) &&
    (filter.eventTypes.length === 0 ||
      filter.eventTypes.includes(envelope.eventType)) &&
    (filter.allowedActors.length === 0 ||
      filter.allowedActors.includes(envelope.actor.id));

  filter.conditions.forEach((condition, index) => {
    if (!evaluateGateCondition(condition, envelope)) {
      unmatchedConditions.push(index);
    }
  });

  const matched =
    violations.length === 0 &&
    headerMatched &&
    unmatchedConditions.length === 0;

  const renderedPreviews = spec.targets.map((target) => {
    switch (target.kind) {
      case 'session':
      case 'bot':
        return renderPulseTemplate(target.promptTemplate, envelope);
      case 'group':
        return renderPulseTemplate(target.messageTemplate, envelope);
      case 'user':
        return renderPulseTemplate(
          `${target.titleTemplate}\n${target.bodyTemplate}`,
          envelope
        );
      case 'workflow':
        return `Workflow ${target.workflowId}@v${target.pinnedVersion}`;
    }
  });

  return {
    valid: violations.length === 0,
    matched,
    violations,
    unmatchedConditions,
    renderedPreviews,
  };
}

const VALID_STEP_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Exhaustively validates a Dual-Primitive `PulseWorkflowDefinition` in one pass (No Fail-Fast).
 */
export function validatePulseWorkflowDefinition(
  definition: PulseWorkflowDefinition
): PulseDryRunViolation[] {
  const violations: PulseDryRunViolation[] = [];

  if (definition.formatVersion !== 1) {
    violations.push({
      path: 'formatVersion',
      code: 'unsupported_format_version',
      message: 'formatVersion must be 1.',
    });
  }

  if (!definition.name.trim()) {
    violations.push({
      path: 'name',
      code: 'empty_workflow_name',
      message: 'Workflow name is required.',
    });
  }

  if (definition.steps.length === 0) {
    violations.push({
      path: 'steps',
      code: 'empty_workflow_steps',
      message: 'Workflow must contain at least one step.',
    });
  }

  const seenIds = new Set<string>();
  const stepMap = new Map<string, PulseWorkflowStep>();

  definition.steps.forEach((step, index) => {
    const base = `steps[${index}]`;
    if (!VALID_STEP_ID.test(step.id)) {
      violations.push({
        path: `${base}.id`,
        code: 'invalid_step_id',
        message: `Step ID '${step.id}' must match /^[A-Za-z0-9_-]{1,80}$/.`,
      });
    } else if (seenIds.has(step.id)) {
      violations.push({
        path: `${base}.id`,
        code: 'duplicate_step_id',
        message: `Duplicate step ID '${step.id}'.`,
      });
    } else {
      seenIds.add(step.id);
      stepMap.set(step.id, step);
    }

    switch (step.kind) {
      case 'session':
        if (!step.agentId.trim()) {
          violations.push({
            path: `${base}.agentId`,
            code: 'missing_session_agent_id',
            message: `Session step '${step.id}' requires agentId.`,
          });
        }
        if (!step.prompt.trim()) {
          violations.push({
            path: `${base}.prompt`,
            code: 'empty_session_prompt',
            message: `Session step '${step.id}' requires prompt.`,
          });
        }
        if (step.refreshContext !== true) {
          violations.push({
            path: `${base}.refreshContext`,
            code: 'session_must_refresh_context',
            message: `Session step '${step.id}' must keep refreshContext=true.`,
          });
        }
        break;
      case 'bot':
        if (!step.memberId.trim()) {
          violations.push({
            path: `${base}.memberId`,
            code: 'missing_bot_member_id',
            message: `Bot step '${step.id}' requires persistent memberId.`,
          });
        }
        if (!step.prompt.trim()) {
          violations.push({
            path: `${base}.prompt`,
            code: 'empty_bot_prompt',
            message: `Bot step '${step.id}' requires prompt.`,
          });
        }
        if (step.preserveContext !== true) {
          violations.push({
            path: `${base}.preserveContext`,
            code: 'bot_must_preserve_context',
            message: `Bot step '${step.id}' must keep preserveContext=true.`,
          });
        }
        break;
      case 'group_stage':
        if (!step.spaceId.trim()) {
          violations.push({
            path: `${base}.spaceId`,
            code: 'missing_group_space_id',
            message: `GroupStage step '${step.id}' requires spaceId.`,
          });
        }
        if (!step.prompt.trim()) {
          violations.push({
            path: `${base}.prompt`,
            code: 'empty_group_prompt',
            message: `GroupStage step '${step.id}' requires prompt.`,
          });
        }
        break;
      case 'user_gate':
        if (!step.title.trim()) {
          violations.push({
            path: `${base}.title`,
            code: 'empty_user_gate_title',
            message: `UserGate step '${step.id}' requires title.`,
          });
        }
        break;
      case 'bounded_loop':
        if (
          !Number.isInteger(step.maxIterations) ||
          step.maxIterations < 1 ||
          step.maxIterations > MAX_BOUNDED_LOOP_ITERATIONS
        ) {
          violations.push({
            path: `${base}.maxIterations`,
            code: 'invalid_max_iterations',
            message: `BoundedLoop step '${step.id}' requires integer maxIterations in 1..=${MAX_BOUNDED_LOOP_ITERATIONS}.`,
          });
        }
        if (step.bodyStepIds.length === 0) {
          violations.push({
            path: `${base}.bodyStepIds`,
            code: 'empty_loop_body',
            message: `BoundedLoop step '${step.id}' requires at least one bodyStepId.`,
          });
        }
        if (!step.conditionPointer.startsWith('/')) {
          violations.push({
            path: `${base}.conditionPointer`,
            code: 'invalid_condition_pointer',
            message: `BoundedLoop step '${step.id}' conditionPointer must start with '/'.`,
          });
        }
        break;
      case 'wait_for_event':
        if (step.eventTypes.length === 0) {
          violations.push({
            path: `${base}.eventTypes`,
            code: 'empty_wait_event_types',
            message: `WaitForEvent step '${step.id}' requires at least one eventType.`,
          });
        }
        if (!Number.isInteger(step.timeoutSeconds) || step.timeoutSeconds < 5) {
          violations.push({
            path: `${base}.timeoutSeconds`,
            code: 'invalid_wait_timeout',
            message: `WaitForEvent step '${step.id}' requires timeoutSeconds >= 5.`,
          });
        }
        break;
      case 'outbox_action':
        if (
          step.actionKind === 'emit_event' &&
          (!step.eventType || !step.eventType.trim())
        ) {
          violations.push({
            path: `${base}.eventType`,
            code: 'missing_outbox_event_type',
            message: `OutboxAction step '${step.id}' with emit_event requires eventType.`,
          });
        }
        break;
    }
  });

  // Dependency & cross-step reference checks
  definition.steps.forEach((step, index) => {
    const base = `steps[${index}]`;
    for (const dep of step.dependsOn) {
      if (dep === step.id) {
        violations.push({
          path: `${base}.dependsOn`,
          code: 'self_dependency',
          message: `Step '${step.id}' cannot depend on itself.`,
        });
      } else if (!stepMap.has(dep)) {
        violations.push({
          path: `${base}.dependsOn`,
          code: 'unknown_dependency',
          message: `Step '${step.id}' depends on unknown step '${dep}'.`,
        });
      }
    }

    if (step.kind === 'bounded_loop') {
      for (const bodyId of step.bodyStepIds) {
        if (!stepMap.has(bodyId)) {
          violations.push({
            path: `${base}.bodyStepIds`,
            code: 'unknown_loop_body_step',
            message: `BoundedLoop '${step.id}' references unknown body step '${bodyId}'.`,
          });
        }
      }
      if (step.onExhaustedStepId && !stepMap.has(step.onExhaustedStepId)) {
        violations.push({
          path: `${base}.onExhaustedStepId`,
          code: 'unknown_exhausted_step',
          message: `BoundedLoop '${step.id}' references unknown onExhaustedStepId '${step.onExhaustedStepId}'.`,
        });
      }
    }

    if (
      step.kind === 'wait_for_event' &&
      step.onTimeoutStepId &&
      !stepMap.has(step.onTimeoutStepId)
    ) {
      violations.push({
        path: `${base}.onTimeoutStepId`,
        code: 'unknown_timeout_step',
        message: `WaitForEvent '${step.id}' references unknown onTimeoutStepId '${step.onTimeoutStepId}'.`,
      });
    }
  });

  // Topological cycle check on known edges
  if (stepMap.size > 0) {
    const inDegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    for (const [id, step] of stepMap.entries()) {
      const validDeps = step.dependsOn.filter((d) => d !== id && stepMap.has(d));
      inDegree.set(id, validDeps.length);
      for (const dep of validDeps) {
        const list = outgoing.get(dep) ?? [];
        list.push(id);
        outgoing.set(dep, list);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    let visited = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      visited += 1;
      for (const next of outgoing.get(current) ?? []) {
        const nextDeg = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, nextDeg);
        if (nextDeg === 0) queue.push(next);
      }
    }

    if (visited !== stepMap.size) {
      violations.push({
        path: 'steps',
        code: 'dependency_cycle',
        message:
          'Workflow dependency graph contains a cycle; use bounded_loop for iterative cycles.',
      });
    }
  }

  return violations;
}
