import { tauriInvoke } from '@/lib/tauriApi';
import type {
  BaseCodingAgent,
  ProviderCapabilityState,
  ProviderCommand,
  ProviderHistorySnapshot,
  ProviderId,
  ProviderRuntimeEvent,
  ProviderRuntimeNormalizedEvent,
  ProviderTurnRequest,
  SlashCommandDescription,
} from 'shared/types';
import type { SlashCommandIconKey } from '@/lib/slashCommandPresentation';
import { providerRuntimeApi } from '@/lib/providerRuntime';

export type ProviderContext = {
  workspaceId: string;
  threadId?: string | null;
  sessionId?: string | null;
  model?: string | null;
};

export type ComposerSubmitInput = {
  text: string;
  images?: string[];
};

export type ProviderCommandPresentation = {
  label: string;
  description: string | null;
  iconKey: SlashCommandIconKey | null;
  isSkill: boolean;
};

export type ProviderThreadOperation =
  | {
      type: 'append_text';
      provider: ProviderId;
      threadId?: string | null;
      turnId?: string | null;
      text: string;
      raw: unknown;
    }
  | {
      type: 'set_status';
      provider: ProviderId;
      threadId?: string | null;
      turnId?: string | null;
      status: 'started' | 'completed' | 'failed' | 'unknown';
      raw: unknown;
    }
  | {
      type: 'raw_diagnostic';
      provider: ProviderId;
      threadId?: string | null;
      turnId?: string | null;
      raw: unknown;
    };

export interface ProviderFrontendAdapter {
  id: ProviderId;
  getCapabilities(): ProviderCapabilityState;
  getFallbackSlashCommands(): SlashCommandDescription[];
  getSlashCommands(context: ProviderContext): Promise<ProviderCommand[]>;
  getSlashCommandPresentation(
    command: SlashCommandDescription
  ): ProviderCommandPresentation;
  buildTurnRequest(
    input: ComposerSubmitInput,
    context: ProviderContext
  ): ProviderTurnRequest;
  mapRuntimeEvent(event: ProviderRuntimeEvent): ProviderThreadOperation[];
  loadHistory(
    sessionId: string,
    context: ProviderContext
  ): Promise<ProviderHistorySnapshot>;
  isSlashCommandVisible(command: SlashCommandDescription): boolean;
}

type ProviderCommandDefinition = SlashCommandDescription & {
  label?: string;
  iconKey?: SlashCommandIconKey;
};

const AVAILABLE_APP_SERVER = {
  state: 'available',
  source: 'app_server',
} as const;

const AVAILABLE_SDK = {
  state: 'available',
  source: 'sdk',
} as const;

const AVAILABLE_CONFIG = {
  state: 'available',
  source: 'config',
} as const;

const PARTIAL_SDK = {
  state: 'partial',
  source: 'sdk',
} as const;

const UNAVAILABLE_NATIVE = {
  state: 'unavailable',
  source: 'native',
} as const;

const CLAUDE_COMMANDS: ProviderCommandDefinition[] = [
  [
    'compact',
    'Compact conversation with an optional focus',
    'Compact',
    'compact',
  ],
  [
    'goal',
    'Set, inspect, pause, resume, or clear a long-running goal',
    'Goal',
    'goal',
  ],
  ['init', 'Initialize a CLAUDE.md file', 'Init', 'init'],
  ['resume', 'Resume a Claude Code conversation', 'Resume', 'command'],
  ['review', 'Review a pull request', 'Review', 'review'],
  ['context', 'Show Claude Code context usage', 'Context', 'command'],
].map(([name, description, label, iconKey]) => ({
  name,
  description,
  label,
  iconKey: iconKey as SlashCommandIconKey,
  kind: 'COMMAND' as const,
}));

const CODEX_COMMANDS: ProviderCommandDefinition[] = [
  [
    'compact',
    'Compact conversation with an optional focus',
    'Compact',
    'compact',
  ],
  [
    'goal',
    'Set, inspect, pause, resume, or clear a long-running goal',
    'Goal',
    'goal',
  ],
  [
    'init',
    'Create an AGENTS.md file with repository instructions',
    'Init',
    'init',
  ],
  ['plan', 'Switch to planning-oriented Codex behavior', 'Plan', 'command'],
  ['review', 'Review code with optional instructions', 'Review', 'review'],
].map(([name, description, label, iconKey]) => ({
  name,
  description,
  label,
  iconKey: iconKey as SlashCommandIconKey,
  kind: 'COMMAND' as const,
}));

const OPENCODE_COMMANDS: ProviderCommandDefinition[] = [
  ['compact', 'Compact the current session', 'Compact', 'compact'],
].map(([name, description, label, iconKey]) => ({
  name,
  description,
  label,
  iconKey: iconKey as SlashCommandIconKey,
  kind: 'COMMAND' as const,
}));

function commandCatalogByProvider(
  provider: ProviderId
): ProviderCommandDefinition[] {
  switch (provider) {
    case 'claude':
      return CLAUDE_COMMANDS;
    case 'codex':
      return CODEX_COMMANDS;
    case 'opencode':
      return OPENCODE_COMMANDS;
  }
}

function capabilityState(provider: ProviderId): ProviderCapabilityState {
  const partialSdk = (detail: string) => ({
    ...PARTIAL_SDK,
    detail,
  });
  const unavailableNative = (detail: string) => ({
    ...UNAVAILABLE_NATIVE,
    detail,
  });

  switch (provider) {
    case 'claude':
      return {
        slash_commands: AVAILABLE_SDK,
        images: AVAILABLE_SDK,
        session_resume: AVAILABLE_SDK,
        session_fork: AVAILABLE_SDK,
        approvals: AVAILABLE_SDK,
        user_input_requests: partialSdk(
          'Interactive prompts depend on the selected Claude surface.'
        ),
        reasoning_control: partialSdk(
          'Reasoning controls map to Claude model or effort choices.'
        ),
        collaboration_mode: unavailableNative(
          'Claude does not expose a Codex-style collaboration mode.'
        ),
        mcp: AVAILABLE_CONFIG,
        provider_control_panel: {
          state: 'partial',
          source: 'config',
          detail:
            'Settings currently cover config files and local availability.',
        },
      };
    case 'codex':
      return {
        slash_commands: AVAILABLE_APP_SERVER,
        images: AVAILABLE_APP_SERVER,
        session_resume: AVAILABLE_APP_SERVER,
        session_fork: AVAILABLE_APP_SERVER,
        approvals: {
          state: 'partial',
          source: 'app_server',
          detail:
            'App-server approval requests are parsed as events; VibeX UI response routing is not fully wired yet.',
        },
        user_input_requests: {
          state: 'partial',
          source: 'app_server',
          detail:
            'Server-initiated app-server requests can be responded to by id, but user-facing prompt surfaces are not complete yet.',
        },
        reasoning_control: AVAILABLE_APP_SERVER,
        collaboration_mode: AVAILABLE_APP_SERVER,
        mcp: AVAILABLE_CONFIG,
        provider_control_panel: {
          state: 'partial',
          source: 'config',
          detail:
            'Native account and config surfaces are available; app-server lifecycle is next.',
        },
      };
    case 'opencode':
      return {
        slash_commands: AVAILABLE_SDK,
        images: partialSdk(
          'OpenCode image support depends on provider and model.'
        ),
        session_resume: AVAILABLE_SDK,
        session_fork: AVAILABLE_SDK,
        approvals: partialSdk(
          'Approval behavior is surfaced through OpenCode SDK permission events.'
        ),
        user_input_requests: partialSdk(
          'Interactive prompts depend on OpenCode SDK permission/question events.'
        ),
        reasoning_control: partialSdk('Reasoning is model/provider specific.'),
        collaboration_mode: partialSdk(
          'OpenCode plan/build behavior is not the same as Codex collaboration mode.'
        ),
        mcp: AVAILABLE_SDK,
        provider_control_panel: AVAILABLE_SDK,
      };
  }
}

function buildProviderTurnRequest(
  provider: ProviderId,
  input: ComposerSubmitInput,
  context: ProviderContext
): ProviderTurnRequest {
  return {
    provider,
    workspace_id: context.workspaceId,
    thread_id: context.threadId ?? undefined,
    session_id: context.sessionId ?? undefined,
    text: input.text,
    model: context.model ?? undefined,
    images: input.images ?? [],
    provider_options: {},
  };
}

function eventMethod(event: ProviderRuntimeEvent): string | null {
  if (
    event.event &&
    typeof event.event === 'object' &&
    'method' in event.event
  ) {
    const method = (event.event as { method?: unknown }).method;
    return typeof method === 'string' ? method : null;
  }
  if (event.event && typeof event.event === 'object' && 'type' in event.event) {
    const type = (event.event as { type?: unknown }).type;
    return typeof type === 'string' ? type : null;
  }
  return null;
}

function threadIdForNormalizedEvent(
  event: ProviderRuntimeEvent,
  normalized: ProviderRuntimeNormalizedEvent
): string | null | undefined {
  return 'thread_id' in normalized && normalized.thread_id !== undefined
    ? normalized.thread_id
    : event.thread_id;
}

function turnIdForNormalizedEvent(
  event: ProviderRuntimeEvent,
  normalized: ProviderRuntimeNormalizedEvent
): string | null | undefined {
  return 'turn_id' in normalized && normalized.turn_id !== undefined
    ? normalized.turn_id
    : event.turn_id;
}

function normalizedOperations(
  provider: ProviderId,
  event: ProviderRuntimeEvent
): ProviderThreadOperation[] {
  const operations: ProviderThreadOperation[] = [];

  for (const normalized of event.normalized ?? []) {
    const threadId = threadIdForNormalizedEvent(event, normalized);
    const turnId = turnIdForNormalizedEvent(event, normalized);

    switch (normalized.kind) {
      case 'turn_started':
        operations.push({
          type: 'set_status',
          provider,
          threadId,
          turnId,
          status: 'started',
          raw: normalized,
        });
        break;
      case 'turn_completed':
        operations.push({
          type: 'set_status',
          provider,
          threadId,
          turnId,
          status: 'completed',
          raw: normalized,
        });
        break;
      case 'turn_error':
        operations.push({
          type: 'set_status',
          provider,
          threadId,
          turnId,
          status: 'failed',
          raw: normalized,
        });
        break;
      case 'assistant_text_delta':
      case 'assistant_text_snapshot':
        if (normalized.text) {
          operations.push({
            type: 'append_text',
            provider,
            threadId,
            turnId,
            text: normalized.text,
            raw: normalized,
          });
        }
        break;
      case 'diagnostic':
      case 'tool_update':
      case 'token_usage':
        operations.push({
          type: 'raw_diagnostic',
          provider,
          threadId,
          turnId,
          raw: normalized,
        });
        break;
    }
  }

  return operations;
}

function mapProviderRuntimeEvent(
  provider: ProviderId,
  event: ProviderRuntimeEvent
): ProviderThreadOperation[] {
  if (event.provider !== provider) {
    return [
      {
        type: 'raw_diagnostic',
        provider,
        threadId: event.thread_id,
        turnId: event.turn_id,
        raw: {
          reason: 'cross_provider_event_ignored',
          expectedProvider: provider,
          event,
        },
      },
    ];
  }

  const normalized = normalizedOperations(provider, event);
  if (normalized.length > 0) {
    return normalized;
  }

  const method = eventMethod(event);
  if (
    method === 'execution_started' ||
    method === 'turn/queued' ||
    method === 'turn/started'
  ) {
    return [
      {
        type: 'set_status',
        provider,
        threadId: event.thread_id,
        turnId: event.turn_id,
        status: 'started',
        raw: event.event,
      },
    ];
  }
  if (method === 'turn/completed') {
    return [
      {
        type: 'set_status',
        provider,
        threadId: event.thread_id,
        turnId: event.turn_id,
        status: 'completed',
        raw: event.event,
      },
    ];
  }
  if (method === 'turn/error') {
    return [
      {
        type: 'set_status',
        provider,
        threadId: event.thread_id,
        turnId: event.turn_id,
        status: 'failed',
        raw: event.event,
      },
    ];
  }

  return [
    {
      type: 'raw_diagnostic',
      provider,
      threadId: event.thread_id,
      turnId: event.turn_id,
      raw: event.event,
    },
  ];
}

function createProviderAdapter(provider: ProviderId): ProviderFrontendAdapter {
  return {
    id: provider,
    getCapabilities: () => capabilityState(provider),
    getFallbackSlashCommands: () => commandCatalogByProvider(provider),
    getSlashCommands: async (context) =>
      tauriInvoke<ProviderCommand[]>('provider_runtime_get_commands', {
        provider,
        workspaceId: context.workspaceId,
        repoId: null,
      }),
    getSlashCommandPresentation: (command) => {
      const providerCommand = commandCatalogByProvider(provider).find(
        (item) => item.name === command.name
      );

      return {
        label: providerCommand?.label ?? command.name,
        description:
          command.description ?? providerCommand?.description ?? null,
        iconKey: providerCommand?.iconKey ?? null,
        isSkill: command.kind === 'SKILL',
      };
    },
    buildTurnRequest: (input, context) =>
      buildProviderTurnRequest(provider, input, context),
    mapRuntimeEvent: (event) => mapProviderRuntimeEvent(provider, event),
    loadHistory: (sessionId) =>
      providerRuntimeApi.loadHistory({
        provider,
        sessionId,
      }),
    isSlashCommandVisible: (command) => {
      if (command.kind === 'SKILL') return true;
      return commandCatalogByProvider(provider).some(
        (item) => item.name === command.name
      );
    },
  };
}

const PROVIDER_ADAPTERS: Record<ProviderId, ProviderFrontendAdapter> = {
  claude: createProviderAdapter('claude'),
  codex: createProviderAdapter('codex'),
  opencode: createProviderAdapter('opencode'),
};

export function providerIdFromExecutor(
  executor: BaseCodingAgent | null | undefined
): ProviderId | null {
  switch (executor) {
    case 'CLAUDE_CODE':
      return 'claude';
    case 'CODEX':
      return 'codex';
    case 'OPENCODE':
      return 'opencode';
    default:
      return null;
  }
}

export function getProviderFrontendAdapter(
  provider: ProviderId
): ProviderFrontendAdapter {
  return PROVIDER_ADAPTERS[provider];
}

export function getProviderFrontendAdapterByExecutor(
  executor: BaseCodingAgent | null | undefined
): ProviderFrontendAdapter | null {
  const provider = providerIdFromExecutor(executor);
  return provider ? getProviderFrontendAdapter(provider) : null;
}
