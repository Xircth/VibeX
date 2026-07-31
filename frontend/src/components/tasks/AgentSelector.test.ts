import { describe, expect, it } from 'vitest';

import { unavailableAgentStatusKey } from './AgentSelector';

describe('AgentSelector unavailable status', () => {
  it('does not mislabel an installed Agent that needs authentication as uninstalled', () => {
    expect(unavailableAgentStatusKey('needs_auth')).toBe(
      'agentSelector.needsAuth'
    );
  });

  it('keeps the installation label only for a genuinely uninstalled Agent', () => {
    expect(unavailableAgentStatusKey('uninstalled')).toBe(
      'agentSelector.notInstalled'
    );
  });
});
