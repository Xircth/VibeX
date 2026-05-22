import { tauriInvoke } from '@/lib/tauriApi';
import type {
  BaseCodingAgent,
  ProviderCapabilityState,
  ProviderCommand,
  ProviderHistorySnapshot,
  ProviderId,
  ProviderRuntimeEvent,
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

function eventText(event: ProviderRuntimeEvent): string | null {
  if (!event.event || typeof event.event !== 'object') return null;
  const record = event.event as Record<string, unknown>;

  const sdkStreamText = providerStreamEventText(record);
  if (sdkStreamText) return sdkStreamText;

  if (record.method === 'item/agentMessage/delta') {
    const params = record.params;
    if (params && typeof params === 'object' && 'delta' in params) {
      const delta = (params as { delta?: unknown }).delta;
      return typeof delta === 'string' && delta ? delta : null;
    }
  }

  if (record.type === 'text_delta') {
    const text = record.text;
    return typeof text === 'string' && text ? text : null;
  }

  if (record.type === 'sdk_event') {
    if (isUserEchoEvent(record)) return null;
    const assistantText = assistantPayloadText(record.event);
    if (assistantText) return assistantText;

    if (isSdkResultEvent(record.event)) {
      const text = record.text;
      return typeof text === 'string' && text.trim() ? text : null;
    }

    return null;
  }

  if (record.type === 'opencode_sdk_event') {
    return opencodeEventText(record);
  }

  if (record.type === 'opencode_sdk_response') {
    return opencodeResponseText(record.response);
  }

  return assistantPayloadText(record);
}

function providerStreamEventText(value: unknown): string | null {
  const record = objectRecord(value);
  if (!record) return null;

  if (record.type === 'sdk_event') {
    return providerStreamEventText(record.event);
  }

  if (record.type !== 'stream_event') return null;

  const event = objectRecord(record.event);
  if (event?.type !== 'content_block_delta') return null;

  const delta = objectRecord(event.delta);
  if (delta?.type !== 'text_delta') return null;

  return typeof delta.text === 'string' && delta.text ? delta.text : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function isSdkResultEvent(value: unknown): boolean {
  const record = objectRecord(value);
  return record?.type === 'result';
}

function opencodeEventPayload(value: unknown): unknown {
  const record = objectRecord(value);
  return record?.event ?? record?.payload ?? value;
}

function opencodeEventText(value: unknown): string | null {
  const payload = opencodeEventPayload(value);
  const record = objectRecord(payload);
  if (!record) return null;
  if (opencodeEventIsUserEcho(record)) return null;

  const eventType = typeof record.type === 'string' ? record.type : null;
  if (eventType?.startsWith('message.part.')) {
    return null;
  }
  if (eventType?.startsWith('session.next.text.')) {
    return null;
  }

  return assistantPayloadText(payload);
}

function opencodeEventIsUserEcho(record: Record<string, unknown>): boolean {
  const properties = objectRecord(record.properties);
  const info = objectRecord(properties?.info) ?? objectRecord(record.info);
  const message = objectRecord(record.message);
  const role =
    properties?.partRole ?? info?.role ?? message?.role ?? record.role;
  return typeof role === 'string' && role.toLowerCase() === 'user';
}

function opencodeResponseText(value: unknown): string | null {
  const record = objectRecord(value);
  if (!record) return null;
  return assistantPayloadText(record) ?? textBlockContent(record.parts);
}

function textBlockContent(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null;

  if (Array.isArray(value)) {
    const text = value
      .map(textBlockContent)
      .filter((part): part is string => !!part)
      .join('');
    return text.trim() ? text : null;
  }

  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const blockType = typeof record.type === 'string' ? record.type : null;
  if (blockType && blockType !== 'text') return null;

  if (typeof record.text === 'string' && record.text.trim()) {
    return record.text;
  }
  return textBlockContent(record.content) ?? textBlockContent(record.parts);
}

function assistantPayloadText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const info = objectRecord(record.info);
  const rawRole = record.role ?? info?.role;
  const role = typeof rawRole === 'string' ? rawRole : null;
  if (role?.toLowerCase() === 'user') return null;

  const eventType = typeof record.type === 'string' ? record.type : null;
  const isAssistant =
    role?.toLowerCase() === 'assistant' ||
    eventType?.toLowerCase() === 'assistant' ||
    eventType === 'agentMessage' ||
    eventType === 'agent_message' ||
    eventType === 'assistantMessage' ||
    eventType === 'assistant_message';
  if (isAssistant) {
    if (typeof record.text === 'string' && record.text.trim()) {
      return record.text;
    }
    return textBlockContent(record.content) ?? textBlockContent(record.parts);
  }

  return (
    assistantPayloadText(record.message) ??
    assistantPayloadText(record.event) ??
    assistantPayloadText(record.payload) ??
    assistantPayloadText(record.response) ??
    assistantPayloadText(record.params) ??
    assistantPayloadText(record.properties) ??
    assistantPayloadText(record.result) ??
    assistantPayloadText(record.item) ??
    assistantPayloadText(record.part)
  );
}

function isUserEchoEvent(record: Record<string, unknown>): boolean {
  const event = record.event;
  if (!event || typeof event !== 'object') return false;
  const eventRecord = event as Record<string, unknown>;
  const message = eventRecord.message;
  if (!message || typeof message !== 'object') return false;
  const role = (message as { role?: unknown }).role;
  return typeof role === 'string' && role.toLowerCase() === 'user';
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

  const text = eventText(event);
  if (text) {
    return [
      {
        type: 'append_text',
        provider,
        threadId: event.thread_id,
        turnId: event.turn_id,
        text,
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
