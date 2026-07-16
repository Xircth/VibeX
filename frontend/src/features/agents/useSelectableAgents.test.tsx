import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSelectableAgents } from './useSelectableAgents';

const listRegistry = vi.fn();
const listSettings = vi.fn();
vi.mock('./api', () => ({
  agentsApi: {
    listRegistry: (...args: unknown[]) => listRegistry(...args),
  },
}));
vi.mock('@/lib/api', () => ({
  agentSettingsApi: { list: (...args: unknown[]) => listSettings(...args) },
}));

function registryEntry(agentType: string, kind: 'npx' | 'uvx') {
  return {
    agent_type: agentType,
    registry_id: agentType,
    name: agentType,
    description: '',
    distribution:
      kind === 'npx'
        ? {
            kind: 'npx',
            version: '1.0.0',
            package: `${agentType}@1.0.0`,
            cmd: agentType,
            args: [],
          }
        : {
            kind: 'uvx',
            version: '1.0.0',
            package: `${agentType}==1.0.0`,
            cmd: agentType,
            args: [],
          },
  };
}

function settingRow(
  agentType: string,
  overrides: Partial<{
    enabled: boolean;
    installed: boolean;
    runtime_ok: boolean;
    installed_version: string | null;
  }> = {}
) {
  return {
    id: 1,
    agent_type: agentType,
    enabled: true,
    sort_order: 0,
    installed_version: null,
    env_json: null,
    config_json: null,
    auto_approve_mode: 'off',
    installed: false,
    runtime_ok: true,
    ...overrides,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useSelectableAgents', () => {
  it('returns an enabled installed agent without starting a selector-side probe', async () => {
    listRegistry.mockResolvedValue([registryEntry('codex', 'npx')]);
    listSettings.mockResolvedValue([settingRow('codex', { installed: true })]);

    const { result } = renderHook(() => useSelectableAgents(), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toMatchObject({
      agent: 'codex',
      enabled: true,
      installed: true,
    });
  });

  it('does not treat an uninstalled npx agent as installed', async () => {
    // Regression for issue #3: `distribution.kind === 'npx'` used to force
    // installed=true, so uninstalled gemini/cline/openclaw were selectable.
    listRegistry.mockResolvedValue([registryEntry('gemini', 'npx')]);
    listSettings.mockResolvedValue([
      settingRow('gemini', { installed: false }),
    ]);

    const { result } = renderHook(() => useSelectableAgents(), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));

    expect(result.current[0]).toMatchObject({
      agent: 'gemini',
      enabled: true,
      installed: false,
    });
  });

  it('marks a uvx agent installed when the backend verified it', async () => {
    // Regression for issue #3: hermes (uvx) used to be the only agent gated on
    // installed_version, misreporting machines where uv+python are ready.
    listRegistry.mockResolvedValue([registryEntry('hermes', 'uvx')]);
    listSettings.mockResolvedValue([settingRow('hermes', { installed: true })]);

    const { result } = renderHook(() => useSelectableAgents(), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));

    expect(result.current[0]).toMatchObject({
      agent: 'hermes',
      installed: true,
    });
  });

  it('keeps backend-verified installed state for marker-detected agents', async () => {
    listRegistry.mockResolvedValue([registryEntry('claude_code', 'npx')]);
    listSettings.mockResolvedValue([
      settingRow('claude_code', { installed: true }),
    ]);

    const { result } = renderHook(() => useSelectableAgents(), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));

    expect(result.current[0]).toMatchObject({
      agent: 'claude_code',
      installed: true,
    });
  });
});
