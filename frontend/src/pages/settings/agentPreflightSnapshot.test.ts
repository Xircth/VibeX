import { describe, expect, it } from 'vitest';
import type { AgentPreflightView } from 'shared/types';

import {
  presentPreflightItems,
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

  it('hides vendor runtime and treats Node/npm as installer bootstrap', () => {
    const items = presentPreflightItems([
      snapshot.items[0],
      {
        id: 'acp',
        label: 'ACP 适配器',
        status: 'fail',
        detail: '未发现 ACP 安装组件。',
        version: null,
        path: null,
        source: null,
        repairable: true,
        update_available: false,
        available_version: null,
        update_group: null,
      },
      {
        id: 'dependency.node',
        label: 'Node.js',
        status: 'fail',
        detail: '未满足依赖',
        version: null,
        path: null,
        source: null,
        repairable: false,
        update_available: false,
        available_version: null,
        update_group: null,
      },
    ]);
    expect(items.map((item) => item.id)).toEqual(['acp', 'dependency.node']);
    expect(items[1]?.status).toBe('warning');
  });
});
