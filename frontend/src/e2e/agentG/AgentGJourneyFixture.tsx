import { useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';
import { Button } from '@/components/ui/button';
import { AutomationsSettings } from '@/pages/settings/AutomationsSettings';
import type { BackendTransport } from '@/lib/backendTransport';
import '@/i18n';

type Scenario = 'success' | 'dirty' | 'overlap' | 'restart';

type Evidence = {
  scenario: Scenario;
  conversationId: string | null;
  turnId: string | null;
  workspaceId: string | null;
  artifact: string | null;
};

const OFFICE_ACTION = {
  pluginId: 'vibex.office',
  actionId: 'create-presentation',
  label: 'Create presentation',
  requiredSkills: ['office-pptx'],
  requiredTools: ['officecli'],
  promptBlocks: [{ type: 'text', text: 'Create an editable PPTX.' }],
  artifactIntent: {
    mediaTypes: [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
    provider: 'officecli',
  },
};

function run(status: string, evidence: Evidence) {
  const terminal = status !== 'running';
  const details: Record<
    Scenario,
    { stopReason: string | null; error: string | null }
  > = {
    success: { stopReason: null, error: null },
    dirty: {
      stopReason: 'dirty_shared_root',
      error: 'Shared root has uncommitted changes',
    },
    overlap: { stopReason: 'overlapping_run', error: null },
    restart: { stopReason: 'restart_reconciliation', error: null },
  };
  return {
    id: `fixture-run-${evidence.scenario}`,
    automationId: 'fixture-automation',
    trigger: 'manual',
    scheduledFor: null,
    status,
    cancellationRequested: false,
    conversationId: evidence.conversationId,
    turnId: evidence.turnId,
    workspaceId: evidence.workspaceId,
    stopReason: details[evidence.scenario].stopReason,
    summary:
      status === 'completed'
        ? `Artifact ${evidence.artifact} · Conversation ${evidence.conversationId} · isolated ${evidence.workspaceId}`
        : null,
    error: details[evidence.scenario].error,
    seen: false,
    startedAt: '2026-07-30T01:00:00Z',
    finishedAt: terminal ? '2026-07-30T01:01:00Z' : null,
  };
}

class FakeAutomationTransport implements BackendTransport {
  readonly environment = 'desktop' as const;
  private automation: Record<string, unknown> | null = null;
  private scenario: Scenario = 'success';
  private pollCount = 0;
  private readonly report: (evidence: Evidence) => void;

  constructor(report: (evidence: Evidence) => void) {
    this.report = report;
  }

  setScenario(scenario: Scenario) {
    this.scenario = scenario;
    this.pollCount = 0;
    this.report({
      scenario,
      conversationId: null,
      turnId: null,
      workspaceId: null,
      artifact: null,
    });
  }

  async call(
    command: string,
    args?: Record<string, unknown>
  ): Promise<unknown> {
    if (command === 'automation_engine_status') return { active: true };
    if (command === 'automation_list')
      return this.automation ? [this.automation] : [];
    if (command === 'automation_templates') {
      return Array.from({ length: 7 }, (_, index) => ({
        id: `template-${index + 1}`,
        draft: {
          name: `Template ${index + 1}`,
          enabled: false,
          trigger: { kind: 'manual' },
          launch: {
            promptBlocks: [
              { type: 'text', text: 'Review the current branch.' },
            ],
            displayText: 'Review the current branch.',
            agent: { agentId: 'codex', executorProfileId: null },
            modeId: null,
            configValues: [],
            pluginActions: [],
            skills: [],
            workspace: {
              projectId: '00000000-0000-0000-0000-000000000000',
              rootFolder: '${workspace_root}',
              branch: null,
              isolation: 'worktree_per_run',
            },
            labelSnapshot: `Template ${index + 1}`,
          },
        },
      }));
    }
    if (command === 'get_projects') return [{ id: 'project-1', name: 'VibeX' }];
    if (command === 'get_project_repositories') {
      return [
        {
          id: 'repo-1',
          display_name: 'VibeX',
          path: '/fixture/VibeX',
          default_target_branch: 'main',
        },
      ];
    }
    if (command === 'get_repo_branches')
      return [{ name: 'main', is_current: true }];
    if (command === 'agent_management_bar') {
      return [
        {
          agent_id: 'codex',
          display_name: 'Codex',
          enabled: true,
          retired: false,
          lifecycle: 'ready',
        },
      ];
    }
    if (command === 'agent_capability_catalog') {
      return {
        current_mode: 'agent',
        modes: [
          { id: 'plan', label: 'Plan' },
          { id: 'agent', label: 'Agent' },
        ],
        config_options: [],
      };
    }
    if (command === 'plugin_action_catalog') {
      return {
        actions: [OFFICE_ACTION],
        readiness: {
          enabled: true,
          dependency: { id: 'officecli', status: 'ready' },
          overall: 'ready',
        },
      };
    }
    if (command === 'automation_create') {
      const input = args?.input as Record<string, unknown>;
      this.automation = {
        id: 'fixture-automation',
        ...input,
        specVersion: 1,
        nextRunAt: null,
        migrationRequired: false,
        unseenFailureCount: 0,
        lastRunStatus: null,
        createdAt: '2026-07-30T00:00:00Z',
        updatedAt: '2026-07-30T00:00:00Z',
      };
      return this.automation;
    }
    if (
      command === 'automation_set_enabled' ||
      command === 'automation_cancel_run'
    ) {
      return null;
    }
    if (command === 'automation_run_now') {
      this.pollCount = 0;
      const evidence: Evidence = {
        scenario: this.scenario,
        conversationId:
          this.scenario === 'success' ? 'conversation-office-1' : null,
        turnId: this.scenario === 'success' ? 'turn-office-1' : null,
        workspaceId: this.scenario === 'success' ? 'worktree-run-1' : null,
        artifact: this.scenario === 'success' ? 'weekly-review.pptx' : null,
      };
      this.report(evidence);
      if (this.scenario === 'dirty') return run('failed', evidence);
      if (this.scenario === 'overlap') return run('skipped', evidence);
      if (this.scenario === 'restart') return run('interrupted', evidence);
      return run('running', evidence);
    }
    if (command === 'automation_runs') {
      const evidence: Evidence = {
        scenario: this.scenario,
        conversationId:
          this.scenario === 'success' ? 'conversation-office-1' : null,
        turnId: this.scenario === 'success' ? 'turn-office-1' : null,
        workspaceId: this.scenario === 'success' ? 'worktree-run-1' : null,
        artifact: this.scenario === 'success' ? 'weekly-review.pptx' : null,
      };
      this.pollCount += 1;
      if (this.scenario === 'success') {
        return [run(this.pollCount > 1 ? 'completed' : 'running', evidence)];
      }
      const status =
        this.scenario === 'dirty'
          ? 'failed'
          : this.scenario === 'overlap'
            ? 'skipped'
            : 'interrupted';
      return [run(status, evidence)];
    }
    throw new Error(`Unsupported fixture command: ${command}`);
  }
}

function JourneySurface() {
  const [evidence, setEvidence] = useState<Evidence>({
    scenario: 'success',
    conversationId: null,
    turnId: null,
    workspaceId: null,
    artifact: null,
  });
  const transport = useMemo(() => new FakeAutomationTransport(setEvidence), []);

  const choose = (scenario: Scenario) => {
    transport.setScenario(scenario);
  };

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-6xl space-y-4">
        <header>
          <h1 className="text-lg font-semibold">
            Automation v2 · Desktop journey
          </h1>
          <p className="mt-1 text-sm text-foreground">
            Production settings UI · fake clock and Agent · canonical
            BackendTransport
          </p>
        </header>
        <section
          aria-label="Fake backend scenarios"
          className="settings-card rounded-lg border p-3"
        >
          <div className="flex flex-wrap gap-2">
            {(['success', 'dirty', 'overlap', 'restart'] as const).map(
              (scenario) => (
                <Button
                  key={scenario}
                  type="button"
                  size="sm"
                  variant="outline"
                  className={
                    evidence.scenario === scenario
                      ? 'bg-foreground text-background hover:bg-foreground/90'
                      : undefined
                  }
                  onClick={() => choose(scenario)}
                >
                  {scenario === 'success'
                    ? 'Office success'
                    : scenario === 'dirty'
                      ? 'Dirty shared root'
                      : scenario === 'overlap'
                        ? 'Overlapping skip'
                        : 'Restart Interrupted'}
                </Button>
              )
            )}
          </div>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-foreground">Worktree</dt>
              <dd>{evidence.workspaceId ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-foreground">Conversation / Turn</dt>
              <dd>
                {evidence.conversationId ?? '—'} / {evidence.turnId ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-foreground">Artifact</dt>
              <dd>{evidence.artifact ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-foreground">Scenario</dt>
              <dd>{evidence.scenario}</dd>
            </div>
          </dl>
        </section>
        <AutomationsSettings transport={transport} pollIntervalMs={250} />
      </div>
    </main>
  );
}

export function AgentGJourneyFixture() {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    []
  );
  return (
    <QueryClientProvider client={queryClient}>
      <LegacyDesignScope>
        <JourneySurface />
      </LegacyDesignScope>
    </QueryClientProvider>
  );
}
