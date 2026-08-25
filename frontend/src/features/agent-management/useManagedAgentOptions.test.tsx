import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useManagedAgentOptions } from './useManagedAgentOptions';

vi.mock('@/features/agents/useSelectableAgents', () => ({
  useSelectableAgents: () => [
    {
      agentId: 'codex',
      displayName: 'Codex',
      enabled: true,
      runnable: true,
      settingsFeatures: ['native_mcp'],
    },
    {
      agentId: 'pi',
      displayName: 'Pi',
      enabled: false,
      runnable: false,
      settingsFeatures: ['pi_configuration'],
    },
    {
      agentId: 'custom.agent',
      displayName: 'Custom',
      enabled: true,
      runnable: false,
      settingsFeatures: [],
    },
  ],
}));

describe('useManagedAgentOptions', () => {
  it('filters options by a profile-declared settings capability', () => {
    const { result } = renderHook(() => useManagedAgentOptions('native_mcp'));
    expect(result.current).toEqual([
      {
        value: 'codex',
        label: 'Codex',
        iconLight: null,
        iconDark: null,
        iconSvg: null,
        runnable: true,
      },
    ]);
  });

  it('keeps every managed Agent when no capability is requested', () => {
    const { result } = renderHook(() => useManagedAgentOptions());
    expect(result.current.map((option) => option.value)).toEqual([
      'codex',
      'pi',
      'custom.agent',
    ]);
  });

  it('keeps only enabled Agents when requested', () => {
    const { result } = renderHook(() =>
      useManagedAgentOptions(undefined, true)
    );
    expect(result.current.map((option) => option.value)).toEqual([
      'codex',
      'custom.agent',
    ]);
    expect(result.current.map((option) => option.runnable)).toEqual([
      true,
      false,
    ]);
  });
});
