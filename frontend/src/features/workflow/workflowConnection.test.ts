import { describe, expect, it } from 'vitest';

import {
  buildWorkflowGraph,
  getStepOutputPorts,
  isWorkflowConnectionValid,
  toBackendWorkflowDefinition,
  toStudioWorkflowDefinition,
  wouldCreateWorkflowCycle,
  type StudioWorkflowDefinition,
  type WorkflowGraphStepLike,
} from './WorkflowStudio';

describe('isWorkflowConnectionValid & wouldCreateWorkflowCycle', () => {
  it('allows an Agent node to connect to its confirmation node', () => {
    expect(
      isWorkflowConnectionValid({
        source: 'start',
        target: 'confirmation:start',
      })
    ).toBe(true);
    expect(
      isWorkflowConnectionValid({
        source: 'confirmation:start',
        target: 'start',
      })
    ).toBe(true);
  });

  it('allows an Agent node to connect to another step or its confirmation', () => {
    expect(
      isWorkflowConnectionValid({ source: 'start', target: 'finish' })
    ).toBe(true);
    expect(
      isWorkflowConnectionValid({
        source: 'confirmation:start',
        target: 'finish',
      })
    ).toBe(true);
  });

  it('rejects a true self-loop', () => {
    expect(
      isWorkflowConnectionValid({ source: 'start', target: 'start' })
    ).toBe(false);
    expect(
      isWorkflowConnectionValid({
        source: 'confirmation:start',
        target: 'confirmation:start',
      })
    ).toBe(false);
    expect(
      wouldCreateWorkflowCycle([{ id: 'start', dependsOn: [] }], 'start', 'start')
    ).toBe(true);
  });

  it('detects direct and transitive DAG cycles while permitting diamond fan-out/fan-in DAGs', () => {
    const diamondSteps: WorkflowGraphStepLike[] = [
      { id: 'trigger-1', kind: 'trigger', dependsOn: [] },
      { id: 'branch-a', kind: 'session', dependsOn: ['trigger-1'] },
      { id: 'branch-b', kind: 'bot', dependsOn: ['trigger-1'] },
      { id: 'merge', kind: 'group_stage', dependsOn: ['branch-a'] },
    ];

    // Completing the diamond (`branch-b -> merge`) is valid and cycle-free
    expect(wouldCreateWorkflowCycle(diamondSteps, 'branch-b', 'merge')).toBe(
      false
    );
    expect(
      isWorkflowConnectionValid(
        { source: 'branch-b', target: 'merge' },
        diamondSteps
      )
    ).toBe(true);

    // Direct back-edge (`branch-a -> trigger-1` or `merge -> branch-a`) creates a cycle
    expect(wouldCreateWorkflowCycle(diamondSteps, 'merge', 'branch-a')).toBe(
      true
    );
    expect(
      isWorkflowConnectionValid(
        { source: 'merge', target: 'branch-a' },
        diamondSteps
      )
    ).toBe(false);

    // Transitive back-edge (`merge -> trigger-1`) and any edge into a trigger are rejected
    expect(wouldCreateWorkflowCycle(diamondSteps, 'merge', 'trigger-1')).toBe(
      true
    );
    expect(
      isWorkflowConnectionValid(
        { source: 'branch-b', target: 'trigger-1' },
        diamondSteps
      )
    ).toBe(false);
  });

  it('allows bounded_loop branch:loop_body to target an upstream step without corrupting DAG cycles', () => {
    const loopSteps: WorkflowGraphStepLike[] = [
      { id: 'intake', kind: 'trigger', dependsOn: [] },
      { id: 'coder', kind: 'session', dependsOn: ['intake'] },
      {
        id: 'review-loop',
        kind: 'control',
        controlKind: 'bounded_loop',
        dependsOn: ['coder'],
      },
    ];

    expect(
      isWorkflowConnectionValid(
        {
          source: 'review-loop',
          target: 'coder',
          sourceHandle: 'branch:loop_body',
        },
        loopSteps
      )
    ).toBe(true);

    // Exit port cannot loop back to an ancestor
    expect(
      isWorkflowConnectionValid(
        {
          source: 'review-loop',
          target: 'coder',
          sourceHandle: 'branch:loop_exit',
        },
        loopSteps
      )
    ).toBe(false);

    // Loop body still cannot target a trigger node
    expect(
      isWorkflowConnectionValid(
        {
          source: 'review-loop',
          target: 'intake',
          sourceHandle: 'branch:loop_body',
        },
        loopSteps
      )
    ).toBe(false);
  });
});

describe('Multi-Port Graph Layout & Lossless Codec Persistence', () => {
  const multiPortWorkflow: StudioWorkflowDefinition = {
    formatVersion: 1,
    name: 'Multi-Port Diamond & Branch Workflow',
    description: 'Tests fan-out, fan-in, and semantic branch ports',
    inputSchema: { type: 'object' },
    policy: {
      maxConcurrentAgentSteps: 4,
      maxAgentCalls: 10,
      deadlineSeconds: 1800,
      maxOutputBytes: 65536,
    },
    steps: [
      {
        id: 'intake',
        dependsOn: [],
        phase: null,
        inputBindings: {},
        kind: 'trigger',
        title: 'PR Opened',
        triggerKind: 'platform',
        sourceKind: 'github',
        eventType: 'github.pr.opened',
        evalMode: 'auto',
        temporal: null,
        filter: {
          sourceKinds: ['github'],
          sourceInstanceIds: [],
          eventTypes: ['github.pr.opened'],
          allowedActors: [],
          conditions: [],
        },
      },
      {
        id: 'severity-check',
        dependsOn: ['intake'],
        phase: null,
        inputBindings: {},
        kind: 'control',
        controlKind: 'condition',
        title: 'Severity Check',
        expression: 'event.risk == "high"',
      },
      {
        id: 'approval-gate',
        dependsOn: ['severity-check'],
        branchPorts: { 'severity-check': 'branch:true' },
        phase: null,
        inputBindings: {},
        kind: 'user_gate',
        interactionKind: 'approval',
        severity: 'urgent',
        title: 'Security Sign-Off',
        bodyTemplate: 'Approve {{threadKey}}?',
      },
      {
        id: 'fast-lane',
        dependsOn: ['severity-check'],
        branchPorts: { 'severity-check': 'branch:false' },
        phase: null,
        inputBindings: {},
        kind: 'session',
        agentId: 'codex',
        prompt: 'Fast-track {{threadKey}}',
        workspaceIsolation: 'isolated_worktree',
        executorProfileId: null,
        modeOverride: null,
        configOverrides: {},
        outputLanguage: 'en',
        outputDescription: null,
        outputSchema: null,
        completionPolicy: 'automatic',
      },
      {
        id: 'rollback-bot',
        dependsOn: ['approval-gate'],
        branchPorts: { 'approval-gate': 'branch:rejected' },
        phase: null,
        inputBindings: {},
        kind: 'bot',
        memberId: 'ops-bot',
        conversationScope: 'fixed_primary',
        mailboxPolicy: 'fifo_serial',
        prompt: 'Record rejection on {{threadKey}}',
      },
      {
        id: 'final-outbox',
        dependsOn: ['approval-gate', 'fast-lane'],
        branchPorts: { 'approval-gate': 'branch:approved' },
        joinMode: 'any',
        phase: null,
        inputBindings: {},
        kind: 'outbox_action',
        actionKind: 'github_comment',
        title: 'Post Summary',
        destination: '{{threadKey}}',
        payloadTemplate: 'Completed {{threadKey}}',
      },
    ],
  };

  it('omits static handles on ReactFlow nodes and maps semantic branch ports onto edges', () => {
    const { nodes, edges } = buildWorkflowGraph({
      definition: multiPortWorkflow,
    });

    expect(nodes).toHaveLength(6);
    for (const node of nodes) {
      expect(node.handles).toBeUndefined();
    }

    const condStep = multiPortWorkflow.steps.find(
      (s) => s.id === 'severity-check'
    )!;
    const gateStep = multiPortWorkflow.steps.find(
      (s) => s.id === 'approval-gate'
    )!;
    expect(getStepOutputPorts(condStep).map((p) => p.id)).toEqual([
      'branch:true',
      'branch:false',
    ]);
    expect(getStepOutputPorts(gateStep).map((p) => p.id)).toEqual([
      'branch:approved',
      'branch:rejected',
    ]);

    const trueEdge = edges.find(
      (edge) => edge.id === 'severity-check->approval-gate'
    );
    const falseEdge = edges.find(
      (edge) => edge.id === 'severity-check->fast-lane'
    );
    const rejectedEdge = edges.find(
      (edge) => edge.id === 'approval-gate->rollback-bot'
    );
    const approvedEdge = edges.find(
      (edge) => edge.id === 'approval-gate->final-outbox'
    );

    expect(trueEdge?.sourceHandle).toBe('branch:true');
    expect(falseEdge?.sourceHandle).toBe('branch:false');
    expect(rejectedEdge?.sourceHandle).toBe('branch:rejected');
    expect(approvedEdge?.sourceHandle).toBe('branch:approved');
    expect(trueEdge?.label).toBeTruthy();
    expect(falseEdge?.label).toBeTruthy();
  });

  it('round-trips branchPorts, joinMode, and condition_branch thenStepIds/elseStepIds losslessly', () => {
    const backend = toBackendWorkflowDefinition(multiPortWorkflow);
    const backendCond = backend.steps.find((s) => s.id === 'severity-check');
    expect(backendCond?.kind).toBe('condition_branch');
    if (backendCond?.kind === 'condition_branch') {
      expect(backendCond.thenStepIds).toEqual(['approval-gate']);
      expect(backendCond.elseStepIds).toEqual(['fast-lane']);
    }

    const restored = toStudioWorkflowDefinition(backend);
    const restoredFastLane = restored.steps.find((s) => s.id === 'fast-lane');
    const restoredRollback = restored.steps.find(
      (s) => s.id === 'rollback-bot'
    );
    const restoredFinal = restored.steps.find((s) => s.id === 'final-outbox');

    expect(restoredFastLane?.branchPorts).toEqual({
      'severity-check': 'branch:false',
    });
    expect(restoredRollback?.branchPorts).toEqual({
      'approval-gate': 'branch:rejected',
    });
    expect(restoredFinal?.branchPorts).toEqual({
      'approval-gate': 'branch:approved',
    });
    expect(restoredFinal?.joinMode).toBe('any');
  });

  it('centers DAG columns along a shared horizontal spine, orders upper/lower branch ports without crossing, and keeps manual confirmation pills clear of cards', () => {
    const reversedBranchOrder: StudioWorkflowDefinition = {
      ...multiPortWorkflow,
      steps: [
        multiPortWorkflow.steps[0]!,
        multiPortWorkflow.steps[1]!,
        // Intentionally list branch:false before branch:true in array order
        multiPortWorkflow.steps[3]!, // fast-lane (branch:false)
        multiPortWorkflow.steps[2]!, // approval-gate (branch:true)
        multiPortWorkflow.steps[4]!,
        multiPortWorkflow.steps[5]!,
      ],
    };
    const { nodes } = buildWorkflowGraph({ definition: reversedBranchOrder });
    const byId = new Map(nodes.map((node) => [node.id, node]));

    const intake = byId.get('intake')!;
    const check = byId.get('severity-check')!;
    const trueBranch = byId.get('approval-gate')!;
    const falseBranch = byId.get('fast-lane')!;

    expect(intake.position.y).toBe(check.position.y);
    expect(trueBranch.position.y).toBeLessThan(falseBranch.position.y);
    const branchMidpointY =
      (trueBranch.position.y + falseBranch.position.y) / 2;
    expect(branchMidpointY).toBe(check.position.y);

    const baseSessionStep = multiPortWorkflow.steps[3]! as Extract<
      StudioWorkflowDefinition['steps'][number],
      { kind: 'session' }
    >;
    const manualFlow: StudioWorkflowDefinition = {
      ...multiPortWorkflow,
      steps: [
        {
          ...baseSessionStep,
          id: 'draft',
          dependsOn: [],
          branchPorts: undefined,
          completionPolicy: 'manual',
        },
        {
          ...baseSessionStep,
          id: 'publish',
          dependsOn: ['draft'],
          branchPorts: undefined,
          completionPolicy: 'automatic',
        },
      ],
    };
    const manualGraph = buildWorkflowGraph({ definition: manualFlow });
    const draftNode = manualGraph.nodes.find((node) => node.id === 'draft')!;
    const confirmNode = manualGraph.nodes.find(
      (node) => node.id === 'confirmation:draft'
    )!;
    const publishNode = manualGraph.nodes.find(
      (node) => node.id === 'publish'
    )!;

    const draftRight = draftNode.position.x + (draftNode.initialWidth ?? 280);
    const confirmRight =
      confirmNode.position.x + (confirmNode.initialWidth ?? 148);
    expect(confirmNode.position.x).toBeGreaterThan(draftRight);
    expect(publishNode.position.x).toBeGreaterThan(confirmRight);
  });
});
