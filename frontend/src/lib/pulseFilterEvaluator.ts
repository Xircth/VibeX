import type {
  EventEnvelope,
  GateFilterAst,
  GateFilterCondition,
  PulseDryRunReport,
  PulseDryRunViolation,
  PulseRuleSpec,
} from '@/lib/api/pulse';

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

function evaluateCondition(
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

  if (!spec.name.trim()) {
    violations.push({
      path: 'name',
      code: 'empty_name',
      message: 'Rule name is required.',
    });
  }

  if (spec.targets.length === 0) {
    violations.push({
      path: 'targets',
      code: 'empty_targets',
      message: 'At least one target is required.',
    });
  }

  spec.filter.conditions.forEach((condition, index) => {
    if (condition.op !== 'not_bot_actor' && !condition.pointer.trim()) {
      violations.push({
        path: `filter.conditions[${index}].pointer`,
        code: 'empty_pointer',
        message: 'JSON Pointer cannot be empty.',
      });
    }
    if (condition.op === 'regex') {
      try {
        new RegExp(condition.pattern);
      } catch (err) {
        violations.push({
          path: `filter.conditions[${index}].pattern`,
          code: 'invalid_regex',
          message:
            err instanceof Error ? err.message : 'Invalid regular expression.',
        });
      }
    }
  });

  if (spec.temporal) {
    if (spec.temporal.kind === 'cron' && !spec.temporal.expression.trim()) {
      violations.push({
        path: 'temporal.expression',
        code: 'empty_cron',
        message: 'Cron expression is required.',
      });
    }
    if (
      spec.temporal.kind === 'interval' &&
      spec.temporal.everySeconds < 5
    ) {
      violations.push({
        path: 'temporal.everySeconds',
        code: 'interval_too_short',
        message: 'Interval must be at least 5 seconds.',
      });
    }
    if (
      spec.temporal.kind === 'inactivity_sla' &&
      spec.temporal.timeoutSeconds < 10
    ) {
      violations.push({
        path: 'temporal.timeoutSeconds',
        code: 'sla_timeout_too_short',
        message: 'SLA timeout must be at least 10 seconds.',
      });
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
        break;
      case 'workflow':
        if (!target.workflowId.trim()) {
          violations.push({
            path: `${base}.workflowId`,
            code: 'missing_workflow_id',
            message: 'Workflow target requires a workflowId.',
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
    if (key === 'actor.displayName')
      return envelope.actor.displayName ?? envelope.actor.id;
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

  if (envelope.actor.isSelf || envelope.trace.hopCount > 5) {
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
    if (!evaluateCondition(condition, envelope)) {
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
