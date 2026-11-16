import type {
  EventEnvelope,
  GateFilterAst,
  GateFilterCondition,
  PulseDryRunReport,
  PulseDryRunViolation,
  PulseRuleSpec,
  PulseTargetSpec,
  PulseTemporalSpec,
} from '@/lib/api/pulse';

export const MAX_FILTER_CONDITIONS = 128;
export const MIN_INTERVAL_SECONDS = 1;
export const MAX_INTERVAL_SECONDS = 31_536_000;
export const MIN_SLA_TIMEOUT_SECONDS = 1;
export const DEFAULT_MAX_HOP_COUNT = 5;

const RFC3339_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i;

const MONTH_ALIASES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const DOW_ALIASES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

/**
 * Order-insensitive deep JSON value equality matching Rust `serde_json::Value` equality.
 */
export function deepJsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (
    typeof left === 'number' &&
    typeof right === 'number' &&
    Number.isFinite(left) &&
    Number.isFinite(right)
  ) {
    return Math.abs(left - right) <= Number.EPSILON;
  }
  if (left === null || right === null || left === undefined || right === undefined) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }
    if (left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i += 1) {
      if (!deepJsonEqual(left[i], right[i])) {
        return false;
      }
    }
    return true;
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftObj = left as Record<string, unknown>;
    const rightObj = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftObj).filter(
      (key) => leftObj[key] !== undefined
    );
    const rightKeys = Object.keys(rightObj).filter(
      (key) => rightObj[key] !== undefined
    );
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    for (const key of leftKeys) {
      if (
        !Object.prototype.hasOwnProperty.call(rightObj, key) ||
        rightObj[key] === undefined ||
        !deepJsonEqual(leftObj[key], rightObj[key])
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Validates an RFC 6901 JSON Pointer used in filter conditions, matching `crates/pulse/src/validation.rs`.
 */
export function validateJsonPointer(
  pointer: string
): { code: string; message: string } | null {
  if (!pointer.trim()) {
    return {
      code: 'empty_pointer',
      message: 'JSON Pointer cannot be empty.',
    };
  }
  if (!pointer.startsWith('/')) {
    return {
      code: 'invalid_pointer',
      message: "RFC 6901 JSON Pointer must begin with '/'.",
    };
  }

  for (let i = 0; i < pointer.length; i += 1) {
    if (pointer[i] === '~') {
      const next = pointer[i + 1];
      if (next !== '0' && next !== '1') {
        return {
          code: 'invalid_pointer',
          message:
            'Invalid RFC 6901 escape sequence in JSON Pointer (expected ~0 or ~1).',
        };
      }
      i += 1;
    }
  }

  return null;
}

/**
 * Resolves an RFC 6901 JSON Pointer (e.g. "/issue/priority") against an EventEnvelope or its payload.
 */
export function resolveJsonPointer(root: unknown, pointer: string): unknown {
  if (!pointer || pointer === '/') {
    return root;
  }
  if (pointer.includes('~')) {
    for (let i = 0; i < pointer.length; i += 1) {
      if (pointer[i] === '~') {
        const next = pointer[i + 1];
        if (next !== '0' && next !== '1') {
          return undefined;
        }
        i += 1;
      }
    }
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
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) {
        return undefined;
      }
      const idx = Number(segment);
      if (!Number.isSafeInteger(idx) || idx < 0 || idx >= current.length) {
        return undefined;
      }
      current = current[idx];
    } else if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, segment)) {
        return undefined;
      }
      current = record[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function lookupEnvelopePointer(
  envelope: EventEnvelope,
  pointer: string
): unknown {
  if (!pointer.startsWith('/')) {
    return undefined;
  }
  const fromPayload = resolveJsonPointer(envelope.payload, pointer);
  if (fromPayload !== undefined) {
    return fromPayload;
  }
  return resolveJsonPointer(envelope, pointer);
}

function scalarToComparableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function evaluateCondition(
  condition: GateFilterCondition,
  envelope: EventEnvelope
): boolean {
  if (condition.op === 'not_bot_actor') {
    return !envelope.actor.isBot && !envelope.actor.isSelf;
  }

  if (validateJsonPointer(condition.pointer) !== null) {
    return false;
  }

  const actual = lookupEnvelopePointer(envelope, condition.pointer);

  switch (condition.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'eq':
      return actual !== undefined && deepJsonEqual(actual, condition.value);
    case 'neq':
      return actual !== undefined && !deepJsonEqual(actual, condition.value);
    case 'lt':
      return (
        typeof actual === 'number' &&
        Number.isFinite(actual) &&
        actual < condition.value
      );
    case 'lte':
      return (
        typeof actual === 'number' &&
        Number.isFinite(actual) &&
        actual <= condition.value
      );
    case 'gt':
      return (
        typeof actual === 'number' &&
        Number.isFinite(actual) &&
        actual > condition.value
      );
    case 'gte':
      return (
        typeof actual === 'number' &&
        Number.isFinite(actual) &&
        actual >= condition.value
      );
    case 'contains':
      if (typeof actual === 'string') {
        return actual.includes(condition.needle);
      }
      if (Array.isArray(actual)) {
        return actual.some(
          (item) => scalarToComparableString(item) === condition.needle
        );
      }
      return false;
    case 'in_set':
      return (
        actual !== undefined &&
        condition.values.some((candidate) => deepJsonEqual(actual, candidate))
      );
    case 'regex':
      if (typeof actual !== 'string' || !condition.pattern) {
        return false;
      }
      try {
        return new RegExp(condition.pattern).test(actual);
      } catch {
        return false;
      }
  }
}

function parseCronAtom(
  atom: string,
  min: number,
  max: number,
  aliases?: Record<string, number>
): number | null {
  const upper = atom.toUpperCase();
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, upper)) {
    return aliases[upper]!;
  }
  if (!/^\d+$/.test(atom)) {
    return null;
  }
  const num = Number(atom);
  if (!Number.isInteger(num) || num < min || num > max) {
    return null;
  }
  return num;
}

function isValidCronField(
  field: string,
  min: number,
  max: number,
  aliases?: Record<string, number>
): boolean {
  if (!field) return false;
  if (field === '*' || field === '?') return true;

  for (const part of field.split(',')) {
    if (!part) return false;
    const stepPieces = part.split('/');
    if (stepPieces.length > 2) return false;
    const [rangeExpr, stepExpr] = stepPieces;
    if (!rangeExpr) return false;
    if (stepExpr !== undefined) {
      if (!/^\d+$/.test(stepExpr) || Number(stepExpr) < 1) {
        return false;
      }
    }
    if (rangeExpr === '*' || rangeExpr === '?') {
      continue;
    }
    const bounds = rangeExpr.split('-');
    if (bounds.length === 1) {
      if (parseCronAtom(bounds[0]!, min, max, aliases) === null) {
        return false;
      }
    } else if (bounds.length === 2) {
      const start = parseCronAtom(bounds[0]!, min, max, aliases);
      const end = parseCronAtom(bounds[1]!, min, max, aliases);
      if (start === null || end === null || start > end) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

function looksLikeYearField(field: string): boolean {
  const firstToken = field.split(/[,/-]/)[0] ?? '';
  if (!/^\d{4}$/.test(firstToken)) return false;
  const yr = Number(firstToken);
  return yr >= 1970 && yr <= 2199;
}

export function validateCronExpression(expression: string): string | null {
  const fields = expression.trim().split(/\s+/).filter(Boolean);
  if (fields.length < 5 || fields.length > 7) {
    return `Cron expression must have 5, 6, or 7 fields (got ${fields.length}).`;
  }

  if (fields.length === 5) {
    const valid =
      isValidCronField(fields[0]!, 0, 59) &&
      isValidCronField(fields[1]!, 0, 23) &&
      isValidCronField(fields[2]!, 1, 31) &&
      isValidCronField(fields[3]!, 1, 12, MONTH_ALIASES) &&
      isValidCronField(fields[4]!, 0, 7, DOW_ALIASES);
    return valid ? null : `Invalid 5-field cron expression '${expression}'.`;
  }

  if (fields.length === 6) {
    if (looksLikeYearField(fields[5]!)) {
      const valid =
        isValidCronField(fields[0]!, 0, 59) &&
        isValidCronField(fields[1]!, 0, 23) &&
        isValidCronField(fields[2]!, 1, 31) &&
        isValidCronField(fields[3]!, 1, 12, MONTH_ALIASES) &&
        isValidCronField(fields[4]!, 0, 7, DOW_ALIASES) &&
        isValidCronField(fields[5]!, 1970, 2199);
      return valid ? null : `Invalid 6-field cron expression '${expression}'.`;
    }
    const valid =
      isValidCronField(fields[0]!, 0, 59) &&
      isValidCronField(fields[1]!, 0, 59) &&
      isValidCronField(fields[2]!, 0, 23) &&
      isValidCronField(fields[3]!, 1, 31) &&
      isValidCronField(fields[4]!, 1, 12, MONTH_ALIASES) &&
      isValidCronField(fields[5]!, 0, 7, DOW_ALIASES);
    return valid ? null : `Invalid 6-field cron expression '${expression}'.`;
  }

  // 7-field cron: sec min hour dom month dow year
  const valid =
    isValidCronField(fields[0]!, 0, 59) &&
    isValidCronField(fields[1]!, 0, 59) &&
    isValidCronField(fields[2]!, 0, 23) &&
    isValidCronField(fields[3]!, 1, 31) &&
    isValidCronField(fields[4]!, 1, 12, MONTH_ALIASES) &&
    isValidCronField(fields[5]!, 0, 7, DOW_ALIASES) &&
    isValidCronField(fields[6]!, 1970, 2199);
  return valid ? null : `Invalid 7-field cron expression '${expression}'.`;
}

export function isValidIsoTimestamp(value: string): boolean {
  const trimmed = value.trim();
  const match = RFC3339_TIMESTAMP_RE.exec(trimmed);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const tzHour = match[7] !== undefined ? Number(match[7]) : 0;
  const tzMinute = match[8] !== undefined ? Number(match[8]) : 0;

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 60 ||
    tzHour > 23 ||
    tzMinute > 59
  ) {
    return false;
  }

  const utcProbe = new Date(Date.UTC(year, month - 1, day));
  if (
    utcProbe.getUTCFullYear() !== year ||
    utcProbe.getUTCMonth() !== month - 1 ||
    utcProbe.getUTCDate() !== day
  ) {
    return false;
  }

  const normalized = trimmed.replace(' ', 'T');
  return !Number.isNaN(Date.parse(normalized));
}

function isValidIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function validateTemporalSpec(
  violations: PulseDryRunViolation[],
  temporal: PulseTemporalSpec
) {
  switch (temporal.kind) {
    case 'cron': {
      if (!temporal.expression.trim()) {
        violations.push({
          path: 'temporal.expression',
          code: 'empty_cron',
          message: 'Cron expression is required.',
        });
      } else {
        const cronErr = validateCronExpression(temporal.expression);
        if (cronErr) {
          violations.push({
            path: 'temporal.expression',
            code: 'invalid_cron',
            message: cronErr,
          });
        }
      }

      if (!temporal.timezone.trim()) {
        violations.push({
          path: 'temporal.timezone',
          code: 'empty_timezone',
          message: 'IANA timezone is required.',
        });
      } else if (!isValidIanaTimezone(temporal.timezone.trim())) {
        violations.push({
          path: 'temporal.timezone',
          code: 'invalid_timezone',
          message: `Unknown IANA timezone '${temporal.timezone}'.`,
        });
      }
      break;
    }
    case 'once': {
      if (!temporal.fireAt.trim()) {
        violations.push({
          path: 'temporal.fireAt',
          code: 'empty_fire_at',
          message: 'One-shot fireAt timestamp is required.',
        });
      } else if (!isValidIsoTimestamp(temporal.fireAt)) {
        violations.push({
          path: 'temporal.fireAt',
          code: 'invalid_fire_at',
          message: `Invalid ISO-8601/RFC 3339 timestamp '${temporal.fireAt}'.`,
        });
      }
      break;
    }
    case 'interval': {
      if (
        !Number.isFinite(temporal.everySeconds) ||
        temporal.everySeconds < MIN_INTERVAL_SECONDS
      ) {
        violations.push({
          path: 'temporal.everySeconds',
          code: 'interval_too_short',
          message: `Interval must be at least ${MIN_INTERVAL_SECONDS} second(s).`,
        });
      } else if (temporal.everySeconds > MAX_INTERVAL_SECONDS) {
        violations.push({
          path: 'temporal.everySeconds',
          code: 'interval_too_long',
          message: `Interval cannot exceed ${MAX_INTERVAL_SECONDS} seconds.`,
        });
      }
      break;
    }
    case 'inactivity_sla': {
      if (!temporal.threadKeyPrefix.trim()) {
        violations.push({
          path: 'temporal.threadKeyPrefix',
          code: 'empty_thread_key_prefix',
          message: 'Inactivity SLA requires a non-empty threadKeyPrefix.',
        });
      }
      if (
        !Number.isFinite(temporal.timeoutSeconds) ||
        temporal.timeoutSeconds < MIN_SLA_TIMEOUT_SECONDS
      ) {
        violations.push({
          path: 'temporal.timeoutSeconds',
          code: 'sla_timeout_too_short',
          message: `SLA timeout must be at least ${MIN_SLA_TIMEOUT_SECONDS} second(s).`,
        });
      }
      break;
    }
  }
}

function validateTargetSpec(
  violations: PulseDryRunViolation[],
  index: number,
  target: PulseTargetSpec
) {
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
          code: 'missing_member_id',
          message: 'SpecificSeat dispatch requires a memberId.',
        });
      } else if (
        target.dispatchMode.type === 'mention_seats' &&
        (target.dispatchMode.memberIds.length === 0 ||
          target.dispatchMode.memberIds.some((id) => !id.trim()))
      ) {
        violations.push({
          path: `${base}.dispatchMode.memberIds`,
          code: 'empty_mention_seats',
          message:
            'MentionSeats dispatch requires one or more non-empty memberIds.',
        });
      } else if (
        target.dispatchMode.type === 'moderator_triage' &&
        !target.dispatchMode.moderatorMemberId.trim()
      ) {
        violations.push({
          path: `${base}.dispatchMode.moderatorMemberId`,
          code: 'missing_moderator_member_id',
          message: 'ModeratorTriage dispatch requires a moderatorMemberId.',
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
      if (target.interactionKind === 'approval') {
        const options = target.approvalOptions ?? [];
        if (options.length === 0) {
          violations.push({
            path: `${base}.approvalOptions`,
            code: 'empty_approval_options',
            message:
              'Approval interaction requires at least one approval option.',
          });
        }
        options.forEach((option, optIdx) => {
          if (!option.id.trim()) {
            violations.push({
              path: `${base}.approvalOptions[${optIdx}].id`,
              code: 'empty_option_id',
              message: 'Approval option id is required.',
            });
          }
          if (!option.label.trim()) {
            violations.push({
              path: `${base}.approvalOptions[${optIdx}].label`,
              code: 'empty_option_label',
              message: 'Approval option label is required.',
            });
          }
        });
      }
      if (target.interactionKind === 'ask_form' && !target.formSchema) {
        violations.push({
          path: `${base}.formSchema`,
          code: 'missing_form_schema',
          message: 'AskForm interaction requires a formSchema.',
        });
      }
      if (target.slaTimeoutSeconds === 0) {
        violations.push({
          path: `${base}.slaTimeoutSeconds`,
          code: 'invalid_sla_timeout',
          message: 'SLA timeout must be greater than zero when specified.',
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
      if (!Number.isFinite(target.pinnedVersion) || target.pinnedVersion < 1) {
        violations.push({
          path: `${base}.pinnedVersion`,
          code: 'invalid_pinned_version',
          message: 'Workflow pinnedVersion must be >= 1.',
        });
      }
      break;
  }
}

/**
 * Exhaustively validates a PulseRuleSpec in a single pass (No Fail-Fast),
 * matching `crates/pulse/src/validation.rs`.
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

  if (spec.filter.conditions.length > MAX_FILTER_CONDITIONS) {
    violations.push({
      path: 'filter.conditions',
      code: 'too_many_conditions',
      message: `Filter conditions exceed maximum of ${MAX_FILTER_CONDITIONS} (got ${spec.filter.conditions.length}).`,
    });
  }

  spec.filter.conditions.forEach((condition, index) => {
    const base = `filter.conditions[${index}]`;
    if (condition.op !== 'not_bot_actor') {
      const pointerErr = validateJsonPointer(condition.pointer);
      if (pointerErr) {
        violations.push({
          path: `${base}.pointer`,
          code: pointerErr.code,
          message: pointerErr.message,
        });
      }
    }

    if (
      condition.op === 'lt' ||
      condition.op === 'lte' ||
      condition.op === 'gt' ||
      condition.op === 'gte'
    ) {
      if (!Number.isFinite(condition.value)) {
        violations.push({
          path: `${base}.value`,
          code: 'non_finite_number',
          message: 'Comparison threshold must be a finite number.',
        });
      }
    } else if (condition.op === 'in_set') {
      if (condition.values.length === 0) {
        violations.push({
          path: `${base}.values`,
          code: 'empty_in_set',
          message: 'InSet condition requires at least one candidate value.',
        });
      }
    } else if (condition.op === 'regex') {
      if (!condition.pattern) {
        violations.push({
          path: `${base}.pattern`,
          code: 'invalid_regex',
          message: 'Regular expression pattern cannot be empty.',
        });
      } else {
        try {
          new RegExp(condition.pattern);
        } catch (err) {
          violations.push({
            path: `${base}.pattern`,
            code: 'invalid_regex',
            message:
              err instanceof Error
                ? err.message
                : 'Invalid regular expression.',
          });
        }
      }
    }
  });

  if (spec.temporal) {
    validateTemporalSpec(violations, spec.temporal);
  }

  if (spec.targets.length === 0) {
    violations.push({
      path: 'targets',
      code: 'empty_targets',
      message: 'At least one target is required.',
    });
  }

  spec.targets.forEach((target, index) => {
    validateTargetSpec(violations, index, target);
  });

  return violations;
}

function resolveTemplateToken(key: string, envelope: EventEnvelope): string {
  switch (key) {
    case 'event.id':
    case 'eventId':
      return envelope.eventId;
    case 'delivery.id':
    case 'deliveryId':
      return envelope.deliveryId;
    case 'event.type':
    case 'eventType':
      return envelope.eventType;
    case 'occurredAt':
    case 'event.occurredAt':
      return envelope.occurredAt;
    case 'actor.id':
      return envelope.actor.id;
    case 'actor.displayName':
      return envelope.actor.displayName ?? envelope.actor.id;
    case 'thread.key':
    case 'threadKey':
      return envelope.threadKey ?? '';
    case 'source.instanceId':
      return envelope.source.instanceId;
    case 'source.kind':
      return envelope.source.kind;
    default:
      break;
  }

  const pointer = key.startsWith('/')
    ? key
    : `/${key
        .replace(/^payload\./, '')
        .replace(/\./g, '/')}`;

  const fromPayload = resolveJsonPointer(envelope.payload, pointer);
  const resolved =
    fromPayload !== undefined
      ? fromPayload
      : resolveJsonPointer(envelope, pointer);

  if (resolved === undefined || resolved === null) {
    return '';
  }
  return typeof resolved === 'object'
    ? JSON.stringify(resolved)
    : String(resolved);
}

/**
 * Zero-eval template renderer matching `crates/pulse/src/filter.rs::render_template`.
 * Safely preserves unclosed `{{` tokens without throwing.
 */
export function renderPulseTemplate(
  template: string,
  envelope: EventEnvelope
): string {
  if (!template.includes('{{')) {
    return template;
  }

  let output = '';
  let rest = template;

  while (rest.length > 0) {
    const openIdx = rest.indexOf('{{');
    if (openIdx < 0) {
      output += rest;
      return output;
    }

    output += rest.slice(0, openIdx);
    const afterOpen = rest.slice(openIdx + 2);
    const closeIdx = afterOpen.indexOf('}}');
    if (closeIdx < 0) {
      output += rest.slice(openIdx);
      return output;
    }

    const rawKey = afterOpen.slice(0, closeIdx).trim();
    output += resolveTemplateToken(rawKey, envelope);
    rest = afterOpen.slice(closeIdx + 2);
  }

  return output;
}

export function evaluatePulseRuleLocally(
  spec: PulseRuleSpec,
  envelope: EventEnvelope
): PulseDryRunReport {
  const violations = validatePulseRuleSpec(spec);
  const filter: GateFilterAst = spec.filter;
  const unmatchedConditions: number[] = [];

  if (envelope.actor.isSelf || envelope.trace.hopCount > DEFAULT_MAX_HOP_COUNT) {
    return {
      valid: violations.length === 0,
      matched: false,
      violations,
      unmatchedConditions: [],
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
