import {
  configuredBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';

export type ProviderAuthModeKind =
  | 'OfficialOAuth'
  | 'ApiKey'
  | 'SecretManager';

export type ProviderSecretRef =
  | { kind: 'system_keychain'; keyId: string }
  | { kind: 'env_var'; name: string }
  | { kind: 'one_password'; opRef: string }
  | { kind: 'inline'; value: string };

export type ProviderAuthMode =
  | {
      mode: 'OfficialOAuth';
      oauthTokenRef?: ProviderSecretRef;
      accountEmail?: string | null;
    }
  | {
      mode: 'ApiKey';
      keyRef?: ProviderSecretRef;
      maskedPreview?: string | null;
    }
  | {
      mode: 'SecretManager';
      opReference: string;
    };

export interface ProviderInstanceConfig {
  id?: string;
  instanceId: string;
  agentId: string;
  displayName: string;
  authMode: ProviderAuthMode;
  isDefault: boolean;
  hasActiveSessions?: boolean;
}

export interface UpsertProviderInstanceInput {
  id?: string;
  instanceId?: string;
  agentId: string;
  displayName: string;
  authMode: ProviderAuthMode;
  apiKeySecret?: string;
  isDefault?: boolean;
}

export interface ProviderConnectionTestResult {
  ok: boolean;
  latencyMs?: number;
  accountEmail?: string | null;
  error?: string | null;
}

export interface ProviderInstancesApi {
  list(): Promise<ProviderInstanceConfig[]>;
  create(input: UpsertProviderInstanceInput): Promise<ProviderInstanceConfig>;
  update(
    instanceId: string,
    input: UpsertProviderInstanceInput
  ): Promise<ProviderInstanceConfig>;
  setDefault(agentId: string, instanceId: string): Promise<void>;
  remove(agentId: string, instanceId: string): Promise<void>;
  testConnection(
    target:
      | UpsertProviderInstanceInput
      | { agentId: string; instanceId: string }
  ): Promise<ProviderConnectionTestResult>;
}

export const DEFAULT_PROVIDER_AGENTS: ReadonlyArray<{
  agentId: string;
  label: string;
}> = [
  { agentId: 'claude-code', label: 'Claude Code' },
  { agentId: 'codex', label: 'Codex' },
];

export function formatAgentDisplayLabel(agentId: string): string {
  const normalized = agentId.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'claude-code' || normalized === 'claude') {
    return 'Claude Code';
  }
  if (normalized === 'codex') {
    return 'Codex';
  }
  if (normalized === 'gemini' || normalized === 'gemini-cli') {
    return 'Gemini';
  }
  return agentId;
}

export function normalizeAgentGroupKey(agentId: string): string {
  const normalized = agentId.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'claude' || normalized === 'claudecode') {
    return 'claude-code';
  }
  return normalized || agentId;
}

export function isValidOnePasswordReference(value: string): boolean {
  return /^op:\/\/[^/\s]+\/[^/\s]+\/.+$/i.test(value.trim());
}

export function formatProviderInstanceOptionLabel(
  instance: ProviderInstanceConfig
): string {
  const modeShort =
    instance.authMode.mode === 'OfficialOAuth'
      ? 'OAuth'
      : instance.authMode.mode === 'ApiKey'
        ? 'API Key'
        : '1Password';
  return `${instance.displayName} (${modeShort})`;
}

export function groupProviderInstancesByAgent(
  instances: ReadonlyArray<ProviderInstanceConfig>,
  seedAgents: ReadonlyArray<{ agentId: string; label: string }> =
    DEFAULT_PROVIDER_AGENTS
): Array<{
  agentId: string;
  label: string;
  instances: ProviderInstanceConfig[];
}> {
  const map = new Map<
    string,
    { agentId: string; label: string; instances: ProviderInstanceConfig[] }
  >();

  for (const seed of seedAgents) {
    const key = normalizeAgentGroupKey(seed.agentId);
    map.set(key, { agentId: key, label: seed.label, instances: [] });
  }

  for (const item of instances) {
    const key = normalizeAgentGroupKey(item.agentId);
    const existing = map.get(key);
    if (existing) {
      existing.instances.push(item);
    } else {
      map.set(key, {
        agentId: key,
        label: formatAgentDisplayLabel(key),
        instances: [item],
      });
    }
  }

  return Array.from(map.values());
}

function normalizeAuthMode(raw: unknown): ProviderAuthMode {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return normalizeAuthMode(parsed);
    } catch {
      return { mode: 'OfficialOAuth' };
    }
  }
  if (!raw || typeof raw !== 'object') {
    return { mode: 'OfficialOAuth' };
  }
  const rec = raw as Record<string, unknown>;
  const modeTag = String(rec.mode ?? rec.type ?? rec.kind ?? '');
  if (modeTag === 'SecretManager' || modeTag === 'secret_manager') {
    return {
      mode: 'SecretManager',
      opReference: String(rec.opReference ?? rec.op_reference ?? ''),
    };
  }
  if (modeTag === 'ApiKey' || modeTag === 'api_key') {
    return {
      mode: 'ApiKey',
      maskedPreview:
        typeof rec.maskedPreview === 'string'
          ? rec.maskedPreview
          : typeof rec.masked_preview === 'string'
            ? rec.masked_preview
            : null,
    };
  }
  if (modeTag === 'OfficialOAuth' || modeTag === 'official_oauth') {
    return {
      mode: 'OfficialOAuth',
      accountEmail:
        typeof rec.accountEmail === 'string'
          ? rec.accountEmail
          : typeof rec.account_email === 'string'
            ? rec.account_email
            : null,
    };
  }
  if ('SecretManager' in rec && rec.SecretManager && typeof rec.SecretManager === 'object') {
    const inner = rec.SecretManager as Record<string, unknown>;
    return {
      mode: 'SecretManager',
      opReference: String(inner.op_reference ?? inner.opReference ?? ''),
    };
  }
  if ('ApiKey' in rec && rec.ApiKey && typeof rec.ApiKey === 'object') {
    const inner = rec.ApiKey as Record<string, unknown>;
    return {
      mode: 'ApiKey',
      maskedPreview:
        typeof inner.masked_preview === 'string'
          ? inner.masked_preview
          : typeof inner.maskedPreview === 'string'
            ? inner.maskedPreview
            : null,
    };
  }
  if ('OfficialOAuth' in rec && rec.OfficialOAuth && typeof rec.OfficialOAuth === 'object') {
    const inner = rec.OfficialOAuth as Record<string, unknown>;
    return {
      mode: 'OfficialOAuth',
      accountEmail:
        typeof inner.account_email === 'string'
          ? inner.account_email
          : typeof inner.accountEmail === 'string'
            ? inner.accountEmail
            : null,
    };
  }
  return { mode: 'OfficialOAuth' };
}

export function normalizeProviderInstanceConfig(
  raw: unknown
): ProviderInstanceConfig {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    id: typeof rec.id === 'string' ? rec.id : undefined,
    instanceId: String(rec.instanceId ?? rec.instance_id ?? rec.id ?? ''),
    agentId: normalizeAgentGroupKey(
      String(rec.agentId ?? rec.agent_id ?? 'claude-code')
    ),
    displayName: String(rec.displayName ?? rec.display_name ?? ''),
    authMode: normalizeAuthMode(rec.authMode ?? rec.auth_mode),
    isDefault: Boolean(rec.isDefault ?? rec.is_default),
    hasActiveSessions: Boolean(
      rec.hasActiveSessions ?? rec.has_active_sessions ?? false
    ),
  };
}

function isUnavailableProviderTransport(transport: BackendTransport): boolean {
  return (
    transport === configuredBackendTransport &&
    transport.environment === 'desktop' &&
    typeof window !== 'undefined' &&
    !('__TAURI_INTERNALS__' in window) &&
    !('__TAURI__' in window)
  );
}

function isUnimplementedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /404|not\s*found|unknown\s+command|unimplemented|not\s+implemented|__tauri_internals__|reading\s+'invoke'/i.test(
    msg
  );
}

export function createProviderInstancesApi(
  transport: BackendTransport
): ProviderInstancesApi {
  const call = <T>(
    command: string,
    args?: Record<string, unknown>
  ): Promise<T> => transport.call(command, args) as Promise<T>;

  return {
    async list(): Promise<ProviderInstanceConfig[]> {
      if (isUnavailableProviderTransport(transport)) {
        return [];
      }
      try {
        const rows = await call<unknown[]>('provider_instances_list');
        return Array.isArray(rows)
          ? rows.map(normalizeProviderInstanceConfig)
          : [];
      } catch (error) {
        if (isUnimplementedError(error)) {
          return [];
        }
        throw error;
      }
    },

    async create(
      input: UpsertProviderInstanceInput
    ): Promise<ProviderInstanceConfig> {
      const created = await call<unknown>('provider_instance_create', {
        request: input,
      });
      return normalizeProviderInstanceConfig(created);
    },

    async update(
      instanceId: string,
      input: UpsertProviderInstanceInput
    ): Promise<ProviderInstanceConfig> {
      const updated = await call<unknown>('provider_instance_update', {
        request: { ...input, instanceId },
      });
      return normalizeProviderInstanceConfig(updated);
    },

    async setDefault(agentId: string, instanceId: string): Promise<void> {
      await call('provider_instance_set_default', {
        request: { agentId, instanceId },
      });
    },

    async remove(agentId: string, instanceId: string): Promise<void> {
      await call('provider_instance_delete', {
        request: { agentId, instanceId },
      });
    },

    async testConnection(
      target:
        | UpsertProviderInstanceInput
        | { agentId: string; instanceId: string }
    ): Promise<ProviderConnectionTestResult> {
      const raw = await call<Record<string, unknown>>(
        'provider_instance_test_connection',
        { request: target }
      );
      return {
        ok: Boolean(raw?.ok ?? raw?.success),
        latencyMs:
          typeof raw?.latencyMs === 'number'
            ? raw.latencyMs
            : typeof raw?.latency_ms === 'number'
              ? raw.latency_ms
              : undefined,
        accountEmail:
          typeof raw?.accountEmail === 'string'
            ? raw.accountEmail
            : typeof raw?.account_email === 'string'
              ? raw.account_email
              : null,
        error:
          typeof raw?.error === 'string'
            ? raw.error
            : typeof raw?.message === 'string'
              ? raw.message
              : null,
      };
    },
  };
}

export const providerInstancesApi = createProviderInstancesApi(
  configuredBackendTransport
);
