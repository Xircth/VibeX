import { randomBytes, randomUUID } from 'node:crypto';

import {
  PulseValidationError,
  type EventActor,
  type EventEnvelope,
  type EventSourceKind,
  type EventTrace,
  type EventTrustLevel,
  type JsonSchemaObject,
  type PulseDryRunViolation,
  type PulseEventSchemaView,
  type ReplyChannelAddress,
} from './types.ts';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)+$/;

let lastUlidTimestamp = 0;
let lastUlidRandom = new Uint8Array(10);

/**
 * Generates a monotonic lexicographically sortable 26-char ULID for `EventEnvelope.eventId`.
 */
export function generateUlid(nowMs = Date.now()): string {
  let time = Math.floor(nowMs);
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i -= 1) {
    timeChars[i] = CROCKFORD_BASE32[time % 32];
    time = Math.floor(time / 32);
  }

  let randomPart: Uint8Array;
  if (nowMs === lastUlidTimestamp) {
    randomPart = new Uint8Array(lastUlidRandom);
    for (let i = randomPart.length - 1; i >= 0; i -= 1) {
      if (randomPart[i] < 255) {
        randomPart[i] += 1;
        break;
      }
      randomPart[i] = 0;
    }
  } else {
    randomPart = new Uint8Array(randomBytes(10));
    lastUlidTimestamp = nowMs;
  }
  lastUlidRandom = randomPart;

  const randChars: string[] = [];
  let buffer = 0;
  let bits = 0;
  for (const byte of randomPart) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      randChars.push(CROCKFORD_BASE32[(buffer >>> bits) & 31]);
    }
  }

  return `${timeChars.join('')}${randChars.slice(0, 16).join('')}`;
}

/**
 * Exhaustively validates a JSON Schema definition itself (No Fail-Fast).
 */
export function validateJsonSchemaDefinition(
  schema: unknown,
  path = 'jsonSchema',
  depth = 0
): PulseDryRunViolation[] {
  const violations: PulseDryRunViolation[] = [];
  if (depth > 32) {
    violations.push({
      path,
      code: 'schema_depth_exceeded',
      message: 'JSON Schema exceeds maximum nesting depth of 32.',
    });
    return violations;
  }

  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    violations.push({
      path,
      code: 'invalid_schema_object',
      message: 'JSON Schema node must be a non-null object.',
    });
    return violations;
  }

  const obj = schema as Record<string, unknown>;
  const allowedTypes = new Set([
    'object',
    'array',
    'string',
    'number',
    'integer',
    'boolean',
    'null',
  ]);

  if (obj.type !== undefined) {
    if (typeof obj.type !== 'string' || !allowedTypes.has(obj.type)) {
      violations.push({
        path: `${path}.type`,
        code: 'unsupported_schema_type',
        message: `Schema type must be one of: ${Array.from(allowedTypes).join(', ')}.`,
      });
    }
  }

  if (obj.required !== undefined) {
    if (!Array.isArray(obj.required)) {
      violations.push({
        path: `${path}.required`,
        code: 'invalid_required_array',
        message: '`required` must be an array of non-empty property names.',
      });
    } else {
      const seen = new Set<string>();
      obj.required.forEach((entry, index) => {
        if (typeof entry !== 'string' || !entry.trim()) {
          violations.push({
            path: `${path}.required[${index}]`,
            code: 'invalid_required_entry',
            message: 'Each `required` entry must be a non-empty string.',
          });
        } else if (seen.has(entry)) {
          violations.push({
            path: `${path}.required[${index}]`,
            code: 'duplicate_required_entry',
            message: `Duplicate required property '${entry}'.`,
          });
        } else {
          seen.add(entry);
        }
      });
    }
  }

  if (
    typeof obj.minLength === 'number' &&
    typeof obj.maxLength === 'number' &&
    obj.minLength > obj.maxLength
  ) {
    violations.push({
      path: `${path}.minLength`,
      code: 'invalid_length_bounds',
      message: '`minLength` cannot exceed `maxLength`.',
    });
  }

  if (
    typeof obj.minimum === 'number' &&
    typeof obj.maximum === 'number' &&
    obj.minimum > obj.maximum
  ) {
    violations.push({
      path: `${path}.minimum`,
      code: 'invalid_number_bounds',
      message: '`minimum` cannot exceed `maximum`.',
    });
  }

  if (
    typeof obj.minItems === 'number' &&
    typeof obj.maxItems === 'number' &&
    obj.minItems > obj.maxItems
  ) {
    violations.push({
      path: `${path}.minItems`,
      code: 'invalid_item_bounds',
      message: '`minItems` cannot exceed `maxItems`.',
    });
  }

  if (obj.pattern !== undefined) {
    if (typeof obj.pattern !== 'string') {
      violations.push({
        path: `${path}.pattern`,
        code: 'invalid_pattern_type',
        message: '`pattern` must be a string.',
      });
    } else {
      try {
        new RegExp(obj.pattern);
      } catch (err) {
        violations.push({
          path: `${path}.pattern`,
          code: 'invalid_pattern_regex',
          message: err instanceof Error ? err.message : 'Invalid regex pattern.',
        });
      }
    }
  }

  if (obj.properties !== undefined) {
    if (
      typeof obj.properties !== 'object' ||
      obj.properties === null ||
      Array.isArray(obj.properties)
    ) {
      violations.push({
        path: `${path}.properties`,
        code: 'invalid_properties_map',
        message: '`properties` must be an object mapping field names to schemas.',
      });
    } else {
      for (const [propName, childSchema] of Object.entries(
        obj.properties as Record<string, unknown>
      )) {
        violations.push(
          ...validateJsonSchemaDefinition(
            childSchema,
            `${path}.properties.${propName}`,
            depth + 1
          )
        );
      }
    }
  }

  if (obj.items !== undefined) {
    violations.push(
      ...validateJsonSchemaDefinition(obj.items, `${path}.items`, depth + 1)
    );
  }

  return violations;
}

/**
 * Exhaustively validates a payload value against a JSON Schema in one pass (No Fail-Fast).
 */
export function validatePayloadAgainstSchema(
  schema: JsonSchemaObject,
  value: unknown,
  path = 'payload'
): PulseDryRunViolation[] {
  const violations: PulseDryRunViolation[] = [];

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const serialized = JSON.stringify(value);
    const matched = schema.enum.some(
      (candidate) => JSON.stringify(candidate) === serialized
    );
    if (!matched) {
      violations.push({
        path,
        code: 'enum_mismatch',
        message: `Value at '${path}' must match one of the allowed enum values.`,
      });
    }
  }

  if (schema.type !== undefined) {
    let typeOk = true;
    switch (schema.type) {
      case 'object':
        typeOk =
          typeof value === 'object' && value !== null && !Array.isArray(value);
        break;
      case 'array':
        typeOk = Array.isArray(value);
        break;
      case 'string':
        typeOk = typeof value === 'string';
        break;
      case 'number':
        typeOk = typeof value === 'number' && Number.isFinite(value);
        break;
      case 'integer':
        typeOk = typeof value === 'number' && Number.isInteger(value);
        break;
      case 'boolean':
        typeOk = typeof value === 'boolean';
        break;
      case 'null':
        typeOk = value === null;
        break;
    }

    if (!typeOk) {
      violations.push({
        path,
        code: 'type_mismatch',
        message: `Expected '${schema.type}' at '${path}', got ${
          value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
        }.`,
      });
      return violations;
    }
  }

  if (typeof value === 'string') {
    const charLength = Array.from(value).length;
    if (schema.minLength !== undefined && charLength < schema.minLength) {
      violations.push({
        path,
        code: 'string_too_short',
        message: `String at '${path}' has length ${charLength}, minimum is ${schema.minLength}.`,
      });
    }
    if (schema.maxLength !== undefined && charLength > schema.maxLength) {
      violations.push({
        path,
        code: 'string_too_long',
        message: `String at '${path}' has length ${charLength}, maximum is ${schema.maxLength}.`,
      });
    }
    if (schema.pattern !== undefined) {
      try {
        const regex = new RegExp(schema.pattern);
        if (!regex.test(value)) {
          violations.push({
            path,
            code: 'pattern_mismatch',
            message: `String at '${path}' does not match pattern '${schema.pattern}'.`,
          });
        }
      } catch {
        // Invalid regex already reported by schema definition validator.
      }
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      violations.push({
        path,
        code: 'number_below_minimum',
        message: `Number at '${path}' (${value}) is below minimum ${schema.minimum}.`,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      violations.push({
        path,
        code: 'number_above_maximum',
        message: `Number at '${path}' (${value}) exceeds maximum ${schema.maximum}.`,
      });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      violations.push({
        path,
        code: 'array_too_short',
        message: `Array at '${path}' has ${value.length} items, minimum is ${schema.minItems}.`,
      });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      violations.push({
        path,
        code: 'array_too_long',
        message: `Array at '${path}' has ${value.length} items, maximum is ${schema.maxItems}.`,
      });
    }
    if (schema.items) {
      value.forEach((item, index) => {
        violations.push(
          ...validatePayloadAgainstSchema(schema.items!, item, `${path}[${index}]`)
        );
      });
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const requiredKey of schema.required) {
        if (!(requiredKey in record) || record[requiredKey] === undefined) {
          violations.push({
            path: `${path}.${requiredKey}`,
            code: 'missing_required_field',
            message: `Missing required field '${requiredKey}' at '${path}'.`,
          });
        }
      }
    }

    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in record && record[key] !== undefined) {
          violations.push(
            ...validatePayloadAgainstSchema(
              propSchema,
              record[key],
              `${path}.${key}`
            )
          );
        }
      }

      if (schema.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!(key in schema.properties)) {
            violations.push({
              path: `${path}.${key}`,
              code: 'unexpected_additional_property',
              message: `Additional property '${key}' is not permitted at '${path}'.`,
            });
          }
        }
      }
    }
  }

  return violations;
}

export interface DefineEventOptions<TPayload> {
  eventType: string;
  summary: string;
  jsonSchema: JsonSchemaObject;
  validate?: (payload: TPayload) => PulseDryRunViolation[];
}

export interface CreateEnvelopeOptions<TPayload> {
  payload: TPayload;
  eventId?: string;
  deliveryId?: string;
  occurredAt?: string;
  sourceKind?: EventSourceKind;
  sourceInstanceId?: string;
  trustLevel?: EventTrustLevel;
  actor?: Partial<EventActor>;
  threadKey?: string | null;
  correlations?: string[];
  replyChannels?: ReplyChannelAddress[];
  trace?: Partial<EventTrace>;
  skipValidation?: boolean;
}

export interface PulseEventDescriptor<TPayload> {
  readonly eventType: string;
  readonly summary: string;
  readonly jsonSchema: JsonSchemaObject;
  validatePayload(payload: unknown): PulseDryRunViolation[];
  assertValidPayload(payload: unknown): asserts payload is TPayload;
  createEnvelope(options: CreateEnvelopeOptions<TPayload>): EventEnvelope<TPayload>;
  toSchemaView(updatedAt?: string): PulseEventSchemaView;
}

/**
 * Defines a strongly typed custom Pulse event with exhaustive (No Fail-Fast)
 * schema + custom field validation and an `EventEnvelope` factory.
 */
export function defineEvent<TPayload = Record<string, unknown>>(
  options: DefineEventOptions<TPayload>
): PulseEventDescriptor<TPayload> {
  const definitionViolations: PulseDryRunViolation[] = [];
  const trimmedType = options.eventType.trim();
  const trimmedSummary = options.summary.trim();

  if (!trimmedType || !EVENT_TYPE_PATTERN.test(trimmedType)) {
    definitionViolations.push({
      path: 'eventType',
      code: 'invalid_event_type',
      message:
        'eventType must be a dot-namespaced lowercase identifier (e.g. "ci.coverage.dropped").',
    });
  }

  if (!trimmedSummary) {
    definitionViolations.push({
      path: 'summary',
      code: 'empty_summary',
      message: 'Event summary is required.',
    });
  }

  definitionViolations.push(
    ...validateJsonSchemaDefinition(options.jsonSchema, 'jsonSchema')
  );

  if (definitionViolations.length > 0) {
    throw new PulseValidationError(
      `Invalid event definition '${options.eventType}'`,
      definitionViolations
    );
  }

  const validatePayload = (payload: unknown): PulseDryRunViolation[] => {
    const violations = validatePayloadAgainstSchema(
      options.jsonSchema,
      payload,
      'payload'
    );
    if (options.validate) {
      violations.push(...options.validate(payload as TPayload));
    }
    return violations;
  };

  const assertValidPayload = (payload: unknown): asserts payload is TPayload => {
    const violations = validatePayload(payload);
    if (violations.length > 0) {
      throw new PulseValidationError(
        `Invalid payload for event '${trimmedType}'`,
        violations
      );
    }
  };

  return {
    eventType: trimmedType,
    summary: trimmedSummary,
    jsonSchema: options.jsonSchema,
    validatePayload,
    assertValidPayload,
    createEnvelope(
      envelopeOptions: CreateEnvelopeOptions<TPayload>
    ): EventEnvelope<TPayload> {
      if (!envelopeOptions.skipValidation) {
        assertValidPayload(envelopeOptions.payload);
      }

      const eventId = envelopeOptions.eventId ?? generateUlid();
      const deliveryId = envelopeOptions.deliveryId ?? randomUUID();
      const occurredAt =
        envelopeOptions.occurredAt ?? new Date().toISOString();

      return {
        eventId,
        deliveryId,
        source: {
          kind: envelopeOptions.sourceKind ?? 'sdk_custom',
          instanceId: envelopeOptions.sourceInstanceId ?? 'pulse-sdk',
          trustLevel: envelopeOptions.trustLevel ?? 'trusted_internal',
        },
        eventType: trimmedType,
        occurredAt,
        actor: {
          id: envelopeOptions.actor?.id ?? 'sdk-producer',
          displayName: envelopeOptions.actor?.displayName ?? null,
          roles: envelopeOptions.actor?.roles ?? [],
          isBot: envelopeOptions.actor?.isBot ?? false,
          isSelf: envelopeOptions.actor?.isSelf ?? false,
        },
        threadKey: envelopeOptions.threadKey ?? null,
        correlations: envelopeOptions.correlations ?? [],
        replyChannels: envelopeOptions.replyChannels ?? [],
        trace: {
          rootEventId: envelopeOptions.trace?.rootEventId ?? eventId,
          parentRunId: envelopeOptions.trace?.parentRunId ?? null,
          hopCount: envelopeOptions.trace?.hopCount ?? 0,
        },
        payload: envelopeOptions.payload,
      };
    },
    toSchemaView(updatedAt = new Date().toISOString()): PulseEventSchemaView {
      return {
        eventType: trimmedType,
        summary: trimmedSummary,
        jsonSchema: options.jsonSchema,
        builtIn: false,
        updatedAt,
      };
    },
  };
}
