import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useManagedAgentOptions } from './useManagedAgentOptions';

vi.mock('@/features/agents/useSelectableAgents', () => ({
  useSelectableAgents: () => [
    {
      agentId: 'codex',
      displayName: 'Codex',
      settingsFeatures: ['native_mcp'],
    },
    {
      agentId: 'pi',
      displayName: 'Pi',
      settingsFeatures: ['pi_configuration'],
    },
    {
      agentId: 'custom.agent',
      displayName: 'Custom',
      settingsFeatures: [],
    },
  ],
}));

describe('useManagedAgentOptions', () => {
  it('filters options by a profile-declared settings capability', () => {
    const { result } = renderHook(() => useManagedAgentOptions('native_mcp'));
    expect(result.current).toEqual([{ value: 'codex', label: 'Codex' }]);
  });

  it('keeps every managed Agent when no capability is requested', () => {
    const { result } = renderHook(() => useManagedAgentOptions());
    expect(result.current.map((option) => option.value)).toEqual([
      'codex',
      'pi',
      'custom.agent',
    ]);
  });
});
