import type {
  AgentSessionConfigOverride,
  ExecutorProfileId,
} from 'shared/types';

import type { PluginActionDefinition } from '@/components/plugins/PluginActionEditor';
import {
  configuredBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';

export type AutomationPromptBlock = {
  type: 'text';
  text: string;
};

export type AutomationSchedule =
  | { kind: 'manual' }
  | { kind: 'schedule'; cron: string; timezone: string };

export type AutomationIsolation = 'worktree_per_run' | 'shared_in_root';

export type AutomationPluginActionRef = {
  pluginId: string;
  action: Omit<PluginActionDefinition, 'pluginId' | 'actionId'> & {
    id: string;
  };
};

export type AutomationLaunchInput = {
  promptBlocks: AutomationPromptBlock[];
  displayText: string;
  agent: {
    agentId: string;
    executorProfileId: ExecutorProfileId | null;
  };
  modeId: string | null;
  configValues: AgentSessionConfigOverride[];
  pluginActions: AutomationPluginActionRef[];
  skills: string[];
  workspace: {
    projectId: string;
    rootFolder: string;
    branch: string | null;
    isolation: AutomationIsolation;
  };
  labelSnapshot: string | null;
};

export type AutomationDraftRequest = {
  name: string;
  enabled: boolean;
  trigger: AutomationSchedule;
  launch: AutomationLaunchInput;
};

export type AutomationView = {
  id: string;
  name: string;
  enabled: boolean;
  specVersion: number;
  trigger: AutomationSchedule;
  nextRunAt: string | null;
  launch: AutomationLaunchInput & { specVersion: number };
  migrationRequired: boolean;
  unseenFailureCount: number;
  lastRunStatus: AutomationRunStatus | null;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'skipped';

export type AutomationRunView = {
  id: string;
  automationId: string;
  trigger: 'manual' | 'schedule' | 'catch_up';
  scheduledFor: string | null;
  status: AutomationRunStatus;
  cancellationRequested: boolean;
  conversationId: string | null;
  turnId: string | null;
  workspaceId: string | null;
  stopReason: string | null;
  summary: string | null;
  error: string | null;
  seen: boolean;
  startedAt: string;
  finishedAt: string | null;
};

export type AutomationTemplateView = {
  id: string;
  draft: AutomationDraftRequest;
};

export type AutomationEngineStatus = {
  active: boolean;
};

export function createAutomationApi(transport: BackendTransport) {
  return {
    engineStatus: () =>
      transport.call(
        'automation_engine_status'
      ) as Promise<AutomationEngineStatus>,
    list: () => transport.call('automation_list') as Promise<AutomationView[]>,

    create: (input: AutomationDraftRequest) =>
      transport.call('automation_create', {
        input,
      }) as Promise<AutomationView>,

    update: (id: string, input: AutomationDraftRequest) =>
      transport.call('automation_update', {
        id,
        input,
      }) as Promise<AutomationView>,

    setEnabled: (id: string, enabled: boolean) =>
      transport.call('automation_set_enabled', {
        id,
        enabled,
      }) as Promise<void>,

    remove: (id: string) =>
      transport.call('automation_delete', { id }) as Promise<void>,

    runNow: (id: string) =>
      transport.call('automation_run_now', {
        id,
      }) as Promise<AutomationRunView>,

    cancelRun: (runId: string) =>
      transport.call('automation_cancel_run', { runId }) as Promise<void>,

    runs: (automationId: string, limit?: number) =>
      transport.call('automation_runs', {
        automationId,
        limit: limit ?? null,
      }) as Promise<AutomationRunView[]>,

    previewNextRuns: (cron: string, timezone: string, count = 5) =>
      transport.call('automation_preview_next_runs', {
        cron,
        timezone,
        count,
      }) as Promise<string[]>,

    templates: () =>
      transport.call('automation_templates') as Promise<
        AutomationTemplateView[]
      >,

    unseenFailures: () =>
      transport.call('automation_unseen_failures') as Promise<number>,

    markSeen: () => transport.call('automation_mark_seen') as Promise<void>,
  };
}

export const automationApi = createAutomationApi(configuredBackendTransport);
