import { describe, expect, it } from 'vitest';
import type { AgentPreflightView } from 'shared/types';

import {
  readPreflightSnapshot,
  writePreflightSnapshot,
} from './agentPreflightSnapshot';

const snapshot: AgentPreflightView = {
  agent_id: 'codex',
  checked_at: '2026-08-27T00:00:00Z',
  items: [
    {
      id: 'runtime',
      label: '本地 Runtime',
      status: 'pass',
      detail: '',
      version: '1.0.0',
      path: '/usr/local/bin/codex',
      source: null,
      repairable: true,
      update_available: true,
      available_version: '1.1.0',
      update_group: 'runtime_acp',
    },
  ],
};

describe('agentPreflightSnapshot', () => {
  it('round-trips the last full preflight result', () => {
    writePreflightSnapshot(snapshot);
    expect(readPreflightSnapshot('codex')).toEqual(snapshot);
    expect(readPreflightSnapshot('claude_code')).toBeNull();
  });
});
