import { beforeEach, describe, expect, it, vi } from 'vitest';

const openSettings = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/lib/api', () => ({
  settingsWindowApi: { open: openSettings },
}));

import {
  AGENT_SETTINGS_FOCUS_KEY,
  consumeAgentSettingsFocus,
  openAgentDiagnostics,
} from './agentSettingsFocus';

describe('agent settings focus', () => {
  beforeEach(() => {
    localStorage.clear();
    openSettings.mockClear();
  });

  it('stores a diagnostics focus intent and opens Settings', () => {
    openAgentDiagnostics('claude_code');
    expect(openSettings).toHaveBeenCalledOnce();
    expect(consumeAgentSettingsFocus()).toEqual({
      agentId: 'claude_code',
      focusDiagnostics: true,
    });
    expect(localStorage.getItem(AGENT_SETTINGS_FOCUS_KEY)).toBeNull();
  });
});
