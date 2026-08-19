import { describe, expect, it } from 'vitest';
import {
  clearAgentSettingsDraft,
  clearAllAgentSettingsDrafts,
  peekAgentSettingsDraft,
  retainAgentSettingsDraft,
} from './agentSettingsDraftRetention';

describe('agentSettingsDraftRetention', () => {
  it('keeps a draft after the consumer unmounts', () => {
    clearAllAgentSettingsDrafts();
    retainAgentSettingsDraft('dsh-auth', { mode: 'custom' });
    expect(peekAgentSettingsDraft('dsh-auth')).toEqual({ mode: 'custom' });
    clearAgentSettingsDraft('dsh-auth');
    expect(peekAgentSettingsDraft('dsh-auth')).toBeNull();
  });
});
