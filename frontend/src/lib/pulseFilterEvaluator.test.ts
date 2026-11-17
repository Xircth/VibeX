import { describe, expect, it } from 'vitest';
import type { EventEnvelope, PulseRuleSpec } from '@/lib/api/pulse';
import {
  deepJsonEqual,
  evaluatePulseRuleLocally,
  renderPulseTemplate,
  resolveJsonPointer,
  validateJsonPointer,
  validatePulseRuleSpec,
} from './pulseFilterEvaluator';

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: 'evt-42',
    deliveryId: 'dlv-99',
    source: {
      kind: 'github',
      instanceId: 'gh-prod',
      trustLevel: 'verified_external',
    },
    eventType: 'github.pull_request.opened',
    occurredAt: '2026-11-15T10:30:00Z',
    actor: {
      id: 'user-octocat',
      displayName: 'Octocat',
      roles: ['maintainer'],
      isBot: false,
      isSelf: false,
    },
    threadKey: 'github:vibex/core#42',
    correlations: ['corr-1'],
    replyChannels: [],
    trace: {
      rootEventId: 'evt-42',
      parentRunId: null,
      hopCount: 0,
    },
    payload: {
      summary: 'Fix race condition in dispatcher',
      labels: ['bug', 'urgent'],
      issue: {
        key: 'PROJ-42',
        meta: { b: 2, a: 1 },
      },
      'a/b~c': 'escaped-ok',
    },
    ...overrides,
  };
}

function makeSpec(overrides: Partial<PulseRuleSpec> = {}): PulseRuleSpec {
  return {
    name: 'Test Parity Rule',
    evalMode: 'observe',
    filter: {
      sourceKinds: ['github'],
      sourceInstanceIds: [],
      eventTypes: ['github.pull_request.opened'],
      allowedActors: [],
      conditions: [{ op: 'not_bot_actor' }],
    },
    temporal: null,
    targets: [
      {
        kind: 'session',
        mode: 'ephemeral_fresh',
        agentId: 'claude-code',
        workspaceIsolation: 'isolated_worktree',
        promptTemplate: 'Triage {{event.id}}: {{summary}}',
      },
    ],
    ...overrides,
  };
}

describe('pulseFilterEvaluator Rust <-> TypeScript parity', () => {
  describe('RFC 6901 JSON Pointer validation & unescaping', () => {
    it('rejects empty pointers, missing leading slash, and invalid tilde escapes', () => {
      expect(validateJsonPointer('  ')).toEqual(
        expect.objectContaining({ code: 'empty_pointer' })
      );
      expect(validateJsonPointer('issue/key')).toEqual(
        expect.objectContaining({ code: 'invalid_pointer' })
      );
      expect(validateJsonPointer('/issue/~2bad')).toEqual(
        expect.objectContaining({ code: 'invalid_pointer' })
      );
      expect(validateJsonPointer('/trailing~')).toEqual(
        expect.objectContaining({ code: 'invalid_pointer' })
      );
      expect(validateJsonPointer('/valid~0tilde~1slash')).toBeNull();
    });

    it('resolves ~1 before ~0 per RFC 6901 and rejects leading-zero array indices', () => {
      const envelope = makeEnvelope();
      expect(resolveJsonPointer(envelope.payload, '/a~1b~0c')).toBe(
        'escaped-ok'
      );
      expect(resolveJsonPointer({ '~1': 'literal-tilde-one' }, '/~01')).toBe(
        'literal-tilde-one'
      );
      expect(resolveJsonPointer(envelope.payload, '/labels/1')).toBe('urgent');
      expect(
        resolveJsonPointer(envelope.payload, '/labels/01')
      ).toBeUndefined();
    });

    it('reports invalid_pointer violations in validatePulseRuleSpec without fail-fast', () => {
      const violations = validatePulseRuleSpec(
        makeSpec({
          name: '',
          filter: {
            sourceKinds: [],
            sourceInstanceIds: [],
            eventTypes: [],
            allowedActors: [],
            conditions: [
              { op: 'eq', pointer: 'no-slash', value: 'x' },
              { op: 'neq', pointer: '/bad~escape', value: 'y' },
            ],
          },
        })
      );

      expect(violations.map((v) => v.code)).toEqual([
        'empty_name',
        'invalid_pointer',
        'invalid_pointer',
      ]);
    });
  });

  describe('deepJsonEqual & eq / neq / in_set missing-pointer semantics', () => {
    it('compares nested JSON objects independent of key insertion order', () => {
      expect(
        deepJsonEqual(
          { outer: { a: 1, b: [true, { x: 10, y: 20 }] } },
          { outer: { b: [true, { y: 20, x: 10 }], a: 1 } }
        )
      ).toBe(true);
      expect(deepJsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });

    it('matches eq and in_set with key-order-insensitive object equality', () => {
      const envelope = makeEnvelope();
      const spec = makeSpec({
        filter: {
          sourceKinds: ['github'],
          sourceInstanceIds: [],
          eventTypes: [],
          allowedActors: [],
          conditions: [
            {
              op: 'eq',
              pointer: '/issue/meta',
              value: { a: 1, b: 2 },
            },
            {
              op: 'in_set',
              pointer: '/issue/meta',
              values: [
                { a: 9, b: 9 },
                { a: 1, b: 2 },
              ],
            },
          ],
        },
      });

      const report = evaluatePulseRuleLocally(spec, envelope);
      expect(report.valid).toBe(true);
      expect(report.matched).toBe(true);
    });

    it('evaluates both eq and neq (and in_set) to false when JSON pointer does not resolve', () => {
      const envelope = makeEnvelope();

      const eqMissing = evaluatePulseRuleLocally(
        makeSpec({
          filter: {
            sourceKinds: [],
            sourceInstanceIds: [],
            eventTypes: [],
            allowedActors: [],
            conditions: [{ op: 'eq', pointer: '/missing/field', value: null }],
          },
        }),
        envelope
      );
      expect(eqMissing.matched).toBe(false);

      const neqMissing = evaluatePulseRuleLocally(
        makeSpec({
          filter: {
            sourceKinds: [],
            sourceInstanceIds: [],
            eventTypes: [],
            allowedActors: [],
            conditions: [
              { op: 'neq', pointer: '/missing/field', value: 'anything' },
            ],
          },
        }),
        envelope
      );
      expect(neqMissing.matched).toBe(false);
      expect(neqMissing.unmatchedConditions).toEqual([0]);

      const inSetMissing = evaluatePulseRuleLocally(
        makeSpec({
          filter: {
            sourceKinds: [],
            sourceInstanceIds: [],
            eventTypes: [],
            allowedActors: [],
            conditions: [
              { op: 'in_set', pointer: '/missing/field', values: ['a', null] },
            ],
          },
        }),
        envelope
      );
      expect(inSetMissing.matched).toBe(false);
    });
  });

  describe('Temporal validation parity', () => {
    it('accepts 5, 6, and 7 field cron expressions and rejects wrong field counts or invalid tokens', () => {
      for (const expression of [
        '0 9 * * 1-5',
        '0 0 9 * * MON-FRI',
        '0 0 12 * * ? 2026',
      ]) {
        const violations = validatePulseRuleSpec(
          makeSpec({
            temporal: { kind: 'cron', expression, timezone: 'UTC' },
          })
        );
        expect(violations).toEqual([]);
      }

      for (const badCron of [
        '0 9 * *',
        '0 0 0 9 * * * 2026',
        'bad cron * * *',
      ]) {
        const violations = validatePulseRuleSpec(
          makeSpec({
            temporal: { kind: 'cron', expression: badCron, timezone: 'UTC' },
          })
        );
        expect(violations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: 'temporal.expression',
              code: 'invalid_cron',
            }),
          ])
        );
      }
    });

    it('validates once.fireAt as ISO-8601 / RFC 3339 date', () => {
      expect(
        validatePulseRuleSpec(
          makeSpec({
            temporal: { kind: 'once', fireAt: '2026-11-15T18:30:00+08:00' },
          })
        )
      ).toEqual([]);

      const badOnce = validatePulseRuleSpec(
        makeSpec({
          temporal: { kind: 'once', fireAt: 'tomorrow-morning' },
        })
      );
      expect(badOnce).toEqual([
        expect.objectContaining({
          path: 'temporal.fireAt',
          code: 'invalid_fire_at',
        }),
      ]);
    });

    it('validates interval.everySeconds within [1, 31_536_000]', () => {
      expect(
        validatePulseRuleSpec(
          makeSpec({
            temporal: { kind: 'interval', everySeconds: 1 },
          })
        )
      ).toEqual([]);
      expect(
        validatePulseRuleSpec(
          makeSpec({
            temporal: { kind: 'interval', everySeconds: 31_536_000 },
          })
        )
      ).toEqual([]);

      expect(
        validatePulseRuleSpec(
          makeSpec({
            temporal: { kind: 'interval', everySeconds: 0 },
          })
        )
      ).toEqual([
        expect.objectContaining({
          path: 'temporal.everySeconds',
          code: 'interval_too_short',
        }),
      ]);

      expect(
        validatePulseRuleSpec(
          makeSpec({
            temporal: { kind: 'interval', everySeconds: 31_536_001 },
          })
        )
      ).toEqual([
        expect.objectContaining({
          path: 'temporal.everySeconds',
          code: 'interval_too_long',
        }),
      ]);
    });

    it('validates inactivity_sla threadKeyPrefix and timeoutSeconds >= 1', () => {
      expect(
        validatePulseRuleSpec(
          makeSpec({
            temporal: {
              kind: 'inactivity_sla',
              threadKeyPrefix: 'github:',
              timeoutSeconds: 1,
            },
          })
        )
      ).toEqual([]);

      const badSla = validatePulseRuleSpec(
        makeSpec({
          temporal: {
            kind: 'inactivity_sla',
            threadKeyPrefix: '   ',
            timeoutSeconds: 0,
          },
        })
      );
      expect(badSla.map((v) => v.code)).toEqual([
        'empty_thread_key_prefix',
        'sla_timeout_too_short',
      ]);
    });
  });

  describe('renderPulseTemplate token parity', () => {
    it('expands all envelope metadata tokens, payload paths, top-level payload keys, and preserves unclosed braces', () => {
      const envelope = makeEnvelope();
      const rendered = renderPulseTemplate(
        [
          'id={{event.id}}',
          'dlv={{delivery.id}}',
          'at={{occurredAt}}',
          'thread={{thread.key}}',
          'src={{source.kind}}:{{source.instanceId}}',
          'actor={{actor.id}}({{actor.displayName}})',
          'type={{event.type}}',
          'key={{payload.issue.key}}',
          'top={{summary}}',
          'ptr={{/labels/0}}',
          'unclosed={{keep_verbatim',
        ].join(' | '),
        envelope
      );

      expect(rendered).toBe(
        [
          'id=evt-42',
          'dlv=dlv-99',
          'at=2026-11-15T10:30:00Z',
          'thread=github:vibex/core#42',
          'src=github:gh-prod',
          'actor=user-octocat(Octocat)',
          'type=github.pull_request.opened',
          'key=PROJ-42',
          'top=Fix race condition in dispatcher',
          'ptr=bug',
          'unclosed={{keep_verbatim',
        ].join(' | ')
      );
    });
  });
});
