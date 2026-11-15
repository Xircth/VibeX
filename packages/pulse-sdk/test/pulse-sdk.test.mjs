import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PulseClient,
  PulseValidationError,
  defineEvent,
  evaluatePulseRuleLocally,
  generateUlid,
  pulseRule,
  pulseWorkflow,
  signStandardWebhook,
  verifyStandardWebhook,
} from '../src/index.ts';
import { runCli } from '../src/cli.ts';

test('defineEvent validates schemas and payloads exhaustively (No Fail-Fast) and builds envelopes', () => {
  const CoverageDropped = defineEvent({
    eventType: 'ci.coverage.dropped',
    summary: 'Coverage dropped below target threshold on a tracked branch',
    jsonSchema: {
      type: 'object',
      required: ['repo', 'branch', 'coverage'],
      properties: {
        repo: { type: 'string', minLength: 3 },
        branch: { type: 'string', pattern: '^[a-z0-9/_-]+$' },
        coverage: { type: 'number', minimum: 0, maximum: 100 },
        suites: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', minLength: 2 },
        },
      },
      additionalProperties: false,
    },
    validate(payload) {
      if (payload && typeof payload === 'object' && payload.coverage === 100) {
        return [
          {
            path: 'payload.coverage',
            code: 'not_a_drop',
            message: 'Coverage of 100% cannot be a drop event.',
          },
        ];
      }
      return [];
    },
  });

  // Multiple simultaneous defects must all be collected in one single pass
  const violations = CoverageDropped.validatePayload({
    repo: 'ab',
    branch: 'INVALID BRANCH!',
    coverage: 100,
    suites: ['x', ''],
    extraField: true,
  });

  const codes = violations.map((v) => v.code);
  assert.ok(codes.includes('string_too_short'));
  assert.ok(codes.includes('pattern_mismatch'));
  assert.ok(codes.includes('unexpected_additional_property'));
  assert.ok(codes.includes('not_a_drop'));
  assert.equal(
    violations.filter((v) => v.code === 'string_too_short').length,
    3,
    'repo, suites[0], and suites[1] must all be reported in one pass'
  );

  assert.throws(
    () =>
      CoverageDropped.createEnvelope({
        payload: { repo: 'x' },
      }),
    (err) => err instanceof PulseValidationError && err.violations.length >= 3
  );

  const firstId = generateUlid(1_763_000_000_000);
  const secondId = generateUlid(1_763_000_000_000);
  assert.ok(secondId > firstId, 'ULIDs at identical millisecond must be monotonic');

  const envelope = CoverageDropped.createEnvelope({
    threadKey: 'github:acme/vibex#42',
    correlations: ['jira:CORE-128'],
    trace: { hopCount: 1 },
    payload: {
      repo: 'acme/vibex',
      branch: 'feat/pulse',
      coverage: 74.5,
      suites: ['unit', 'mcp'],
    },
  });

  assert.equal(envelope.eventType, 'ci.coverage.dropped');
  assert.equal(envelope.source.kind, 'sdk_custom');
  assert.equal(envelope.source.trustLevel, 'trusted_internal');
  assert.equal(envelope.threadKey, 'github:acme/vibex#42');
  assert.equal(envelope.trace.hopCount, 1);
  assert.equal(envelope.payload.coverage, 74.5);
});

test('Standard Webhooks signer & constant-time verifier enforce 64KiB cap and 5m replay window', () => {
  const rawSecret = Buffer.from('super-secret-pulse-webhook-key-32b').toString(
    'base64'
  );
  const whsec = `whsec_${rawSecret}`;
  const now = 1_763_200_000;

  const signed = signStandardWebhook({
    secret: whsec,
    deliveryId: 'msg_01JCPULSE',
    timestamp: now - 30,
    payload: { issue: { key: 'PROJ-123', priority: 'P0' } },
  });

  const verified = verifyStandardWebhook({
    secret: whsec,
    headers: {
      'Webhook-Id': signed.headers['webhook-id'],
      'Webhook-Timestamp': signed.headers['webhook-timestamp'],
      'Webhook-Signature': `v1,AAAA ${signed.headers['webhook-signature']}`,
    },
    rawBody: signed.body,
    nowSeconds: now,
  });

  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.deliveryId, 'msg_01JCPULSE');
    assert.deepEqual(verified.payload, {
      issue: { key: 'PROJ-123', priority: 'P0' },
    });
  }

  // Replay outside 5m window fails before signature acceptance
  const expired = verifyStandardWebhook({
    secret: whsec,
    headers: signed.headers,
    rawBody: signed.body,
    nowSeconds: now + 301,
  });
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(expired.code, 'timestamp_out_of_window');
  }

  // Tampered body fails constant-time HMAC check
  const tampered = verifyStandardWebhook({
    secret: whsec,
    headers: signed.headers,
    rawBody: JSON.stringify({ issue: { key: 'PROJ-999', priority: 'P0' } }),
    nowSeconds: now,
  });
  assert.equal(tampered.ok, false);
  if (!tampered.ok) {
    assert.equal(tampered.code, 'signature_mismatch');
  }

  // >64KiB payload rejected before JSON parse
  const hugeBody = `{"blob":"${'a'.repeat(65_536)}"}`;
  const oversized = verifyStandardWebhook({
    secret: whsec,
    headers: signed.headers,
    rawBody: hugeBody,
    nowSeconds: now,
  });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) {
    assert.equal(oversized.code, 'payload_too_large');
  }

  assert.throws(
    () =>
      signStandardWebhook({
        secret: whsec,
        payload: hugeBody,
      }),
    /exceeds 64KiB/
  );
});

test('PulseRuleBuilder builds polymorphic receptor specs and evaluates RFC 6901 filters & loop guards', () => {
  const prGuardRule = pulseRule('PR CI Failure Guard')
    .description('Triage and fix failing CI checks on PRs')
    .mode('observe')
    .orchestrator('superagent_router')
    .fromSources('github')
    .onEventTypes('github.ci.failed')
    .notBotActor()
    .whereEq('/pullRequest/draft', false)
    .whereContains('/labels', 'automerge')
    .whereEq('/meta~1slash/tilde~0key', 'hit')
    .toThreadSession({
      agentId: 'codex',
      workspaceIsolation: 'isolated_worktree',
      promptTemplate: 'Fix CI failure on {{threadKey}} triggered by {{actor.id}}: {{/checkSuite/name}}',
    })
    .toPersistentBot({
      memberId: 'bot-sre-lead',
      conversationScope: 'fixed_primary',
      mailboxPolicy: 'fifo_serial',
      promptTemplate: 'Track recurring failure on {{threadKey}}',
    })
    .toGroupSeat('space-qa', 'seat-qa-bot', 'Investigate {{threadKey}}')
    .toGroupMentions(
      'space-eng',
      ['seat-arch', 'seat-sec'],
      'Review {{threadKey}}',
      'sequential'
    )
    .toUserApproval({
      titleTemplate: 'Approve hotfix for {{threadKey}}',
      bodyTemplate: 'CI suite {{/checkSuite/name}} failed',
    })
    .toUserNotify({
      titleTemplate: 'FYI: {{threadKey}} CI failed',
      bodyTemplate: 'Assigned automated triage',
    })
    .toWorkflow('wf-ci-repair', 2, { prThread: '/threadKey' })
    .build();

  assert.equal(prGuardRule.targets.length, 7);
  assert.equal(prGuardRule.evalMode, 'observe');

  const sampleEnvelope = {
    eventId: '01JCPULSE00000000000000001',
    deliveryId: 'gh-dlv-1',
    source: {
      kind: 'github',
      instanceId: 'gh-main',
      trustLevel: 'verified_external',
    },
    eventType: 'github.ci.failed',
    occurredAt: '2026-11-15T08:00:00Z',
    actor: {
      id: 'alice',
      displayName: 'Alice',
      roles: ['maintainer'],
      isBot: false,
      isSelf: false,
    },
    threadKey: 'github:acme/vibex#88',
    correlations: [],
    replyChannels: [],
    trace: {
      rootEventId: '01JCPULSE00000000000000001',
      parentRunId: null,
      hopCount: 1,
    },
    payload: {
      pullRequest: { draft: false },
      labels: ['automerge', 'backend'],
      checkSuite: { name: 'cargo-test' },
      'meta/slash': { 'tilde~key': 'hit' },
    },
  };

  const report = evaluatePulseRuleLocally(prGuardRule, sampleEnvelope);
  assert.equal(report.valid, true);
  assert.equal(report.matched, true);
  assert.deepEqual(report.unmatchedConditions, []);
  assert.equal(
    report.renderedPreviews[0],
    'Fix CI failure on github:acme/vibex#88 triggered by alice: cargo-test'
  );

  // Self-echo or hopCount > 5 must be blocked by loop guard
  const loopedReport = evaluatePulseRuleLocally(prGuardRule, {
    ...sampleEnvelope,
    trace: { ...sampleEnvelope.trace, hopCount: 6 },
  });
  assert.equal(loopedReport.matched, false);
  assert.deepEqual(loopedReport.unmatchedConditions, [-1]);

  // Temporal builders & exhaustive rule error collection
  const slaRule = pulseRule('P0 Jira SLA')
    .onInactivitySla('jira:CORE-', 1800, ['jira.issue.transitioned'])
    .toUserNotify({
      titleTemplate: 'P0 SLA breached on {{threadKey}}',
      bodyTemplate: 'No transition within 30m',
    })
    .build();
  assert.equal(slaRule.temporal?.kind, 'inactivity_sla');

  const brokenBuilder = pulseRule('')
    .whereEq('missing_leading_slash', 1)
    .whereRegex('/name', '[unclosed')
    .onInterval(1);
  const ruleViolations = brokenBuilder.validate();
  assert.ok(ruleViolations.length >= 4, 'All rule errors collected without fail-fast');
});

test('PulseWorkflowBuilder composes Dual-Primitive SessionStep + BotStep graphs and enforces maxIterations', () => {
  const hybrid = pulseWorkflow('Hybrid PR Delivery Pipeline')
    .orchestrator('hybrid_pipeline')
    .botStep('pm_triage', {
      memberId: 'bot-pm-lead',
      conversationScope: 'fixed_primary',
      mailboxPolicy: 'fifo_serial',
      prompt: 'Decompose ticket into isolated implementation instructions',
    })
    .sessionStep('coder_impl', {
      agentId: 'codex',
      workspaceIsolation: 'isolated_worktree',
      dependsOn: ['pm_triage'],
      prompt: 'Implement changes in clean context worktree',
    })
    .sessionStep('security_review', {
      agentId: 'claude_code',
      workspaceIsolation: 'isolated_worktree',
      dependsOn: ['coder_impl'],
      prompt: 'Perform zero-bias security review with fresh context',
    })
    .groupStageStep('arch_council', {
      spaceId: 'space-arch',
      dispatchMode: {
        type: 'mention_seats',
        memberIds: ['seat-db', 'seat-api'],
        order: 'parallel',
      },
      dependsOn: ['security_review'],
      prompt: 'Converge on schema compatibility',
    })
    .userGateStep('human_release_gate', {
      interactionKind: 'approval',
      title: 'Approve merge after review',
      dependsOn: ['review_loop'],
    })
    .boundedLoopStep('review_loop', {
      dependsOn: ['arch_council'],
      bodyStepIds: ['coder_impl', 'security_review'],
      conditionPointer: '/approved',
      exitEquals: true,
      maxIterations: 3,
      onExhaustedStepId: 'human_release_gate',
    })
    .waitForEventStep('wait_ci_green', {
      dependsOn: ['human_release_gate'],
      eventTypes: ['github.ci.completed'],
      threadKeyPointer: '/threadKey',
      timeoutSeconds: 1800,
    })
    .outboxActionStep('post_jira_comment', {
      dependsOn: ['wait_ci_green'],
      actionKind: 'reply_channel',
      payloadTemplate: { message: 'PR merged and CI verified' },
    })
    .build();

  assert.equal(hybrid.steps.length, 8);
  const pmStep = hybrid.steps.find((s) => s.id === 'pm_triage');
  const coderStep = hybrid.steps.find((s) => s.id === 'coder_impl');
  assert.equal(pmStep?.kind, 'bot');
  assert.equal(pmStep?.preserveContext, true);
  assert.equal(coderStep?.kind, 'session');
  assert.equal(coderStep?.refreshContext, true);

  // Invalid workflow collects all violations in one pass (including maxIterations=0 and cycle)
  const invalidWf = pulseWorkflow('')
    .sessionStep('a', { agentId: '', prompt: '', dependsOn: ['b'] })
    .botStep('b', { memberId: '', prompt: '', dependsOn: ['a'] })
    .boundedLoopStep('loop_bad', {
      bodyStepIds: [],
      conditionPointer: 'bad_pointer',
      maxIterations: 0,
    });
  const wfViolations = invalidWf.validate();
  const wfCodes = wfViolations.map((v) => v.code);
  assert.ok(wfCodes.includes('empty_workflow_name'));
  assert.ok(wfCodes.includes('missing_session_agent_id'));
  assert.ok(wfCodes.includes('missing_bot_member_id'));
  assert.ok(wfCodes.includes('invalid_max_iterations'));
  assert.ok(wfCodes.includes('empty_loop_body'));
  assert.ok(wfCodes.includes('invalid_condition_pointer'));
  assert.ok(wfCodes.includes('dependency_cycle'));
});

test('PulseClient calls /api/pulse/* with Bearer and Standard Webhooks HMAC headers', async () => {
  const secret = `whsec_${Buffer.from('client-hmac-signing-key-32-bytes').toString('base64')}`;
  const recorded = [];

  const client = new PulseClient({
    baseUrl: 'https://vibex.local/',
    bearerToken: 'tok_live_123',
    hmacSecret: secret,
    transport: {
      async send(req) {
        recorded.push(req);
        if (req.path === '/api/pulse/sources') {
          return [
            {
              id: 'src-gh',
              kind: 'github',
              title: 'GitHub App',
              enabled: true,
              healthy: true,
              receivedCount24h: 12,
              rejectedCount24h: 0,
              updatedAt: '2026-11-15T08:00:00Z',
            },
          ];
        }
        if (req.path === '/api/pulse/events/emit') {
          const check = verifyStandardWebhook({
            secret,
            headers: req.headers,
            rawBody: req.body,
          });
          assert.equal(check.ok, true, 'Outbound HMAC signature must verify');
          return JSON.parse(req.body);
        }
        if (req.path === '/api/pulse/schemas') {
          const body = JSON.parse(req.body);
          return {
            ...body,
            builtIn: false,
            updatedAt: '2026-11-15T08:00:00Z',
          };
        }
        if (req.path === '/api/pulse/rules') {
          const body = JSON.parse(req.body);
          return {
            id: 'rule-1',
            revision: 1,
            enabled: body.enabled ?? false,
            draftOnly: false,
            mandateOrigin: 'explicit_human',
            spec: body.spec,
            matchedCount: 0,
            observedCount: 0,
            createdAt: '2026-11-15T08:00:00Z',
            updatedAt: '2026-11-15T08:00:00Z',
          };
        }
        if (req.path === '/api/pulse/rules/dry-run') {
          const { spec, sampleEvent } = JSON.parse(req.body);
          return evaluatePulseRuleLocally(spec, sampleEvent);
        }
        if (req.path === '/api/pulse/subscriptions') {
          const body = JSON.parse(req.body);
          return {
            id: 'sub-1',
            threadKey: body.threadKey,
            subscriberKind: body.subscriberKind,
            subscriberId: body.subscriberId,
            active: true,
            createdAt: '2026-11-15T08:00:00Z',
          };
        }
        if (req.path === '/api/pulse/candidates/cand-7/promote') {
          return { promoted: true, candidateId: 'cand-7' };
        }
        throw new Error(`Unexpected path: ${req.path}`);
      },
    },
  });

  const sources = await client.listSources();
  assert.equal(sources.length, 1);
  assert.equal(recorded[0].headers.authorization, 'Bearer tok_live_123');

  const schemaView = await client.defineSchema({
    eventType: 'deploy.canary.failed',
    summary: 'Canary deployment failed health check',
    jsonSchema: { type: 'object' },
  });
  assert.equal(schemaView.eventType, 'deploy.canary.failed');

  const emitted = await client.emit({
    eventType: 'deploy.canary.failed',
    threadKey: 'jira:OPS-77',
    payload: { service: 'gateway' },
  });
  assert.equal(emitted.threadKey, 'jira:OPS-77');

  const ruleSpec = pulseRule('Canary Alert')
    .onEventTypes('deploy.canary.failed')
    .whereEq('/service', 'gateway')
    .toUserNotify({
      titleTemplate: 'Canary failed: {{service}}',
      bodyTemplate: 'Thread {{threadKey}}',
    })
    .build();

  const saved = await client.saveRule({ spec: ruleSpec, enabled: true });
  assert.equal(saved.id, 'rule-1');

  const dryRun = await client.dryRunRule(ruleSpec, emitted);
  assert.equal(dryRun.matched, true);

  const sub = await client.subscribeThread({
    threadKey: 'jira:OPS-77',
    subscriberKind: 'bot',
    subscriberId: 'bot-sre',
  });
  assert.equal(sub.id, 'sub-1');

  const promoted = await client.promoteCandidate('cand-7');
  assert.equal(promoted.promoted, true);
});

test('vibex-pulse CLI executes emit and dry-run end-to-end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-sdk-cli-'));
  try {
    const emitRes = await runCli([
      'emit',
      '--type',
      'ci.build.completed',
      '--thread',
      'github:acme/vibex#99',
      '--data',
      '{"status":"failed","exitCode":1}',
      '--offline',
    ]);
    assert.equal(emitRes.exitCode, 0);
    const envelope = JSON.parse(emitRes.stdout);
    assert.equal(envelope.eventType, 'ci.build.completed');
    assert.equal(envelope.threadKey, 'github:acme/vibex#99');

    const spec = pulseRule('CLI Dry Run Rule')
      .onEventTypes('ci.build.completed')
      .whereEq('/status', 'failed')
      .toFreshSession({
        agentId: 'codex',
        promptTemplate: 'Investigate build failure on {{threadKey}}',
      })
      .build();

    const ruleFile = join(dir, 'rule.json');
    const eventFile = join(dir, 'event.json');
    await writeFile(ruleFile, JSON.stringify(spec, null, 2), 'utf8');
    await writeFile(eventFile, JSON.stringify(envelope, null, 2), 'utf8');

    const dryRes = await runCli([
      'dry-run',
      '--rule',
      ruleFile,
      '--event',
      eventFile,
    ]);
    assert.equal(dryRes.exitCode, 0);
    const report = JSON.parse(dryRes.stdout);
    assert.equal(report.valid, true);
    assert.equal(report.matched, true);
    assert.equal(
      report.renderedPreviews[0],
      'Investigate build failure on github:acme/vibex#99'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
