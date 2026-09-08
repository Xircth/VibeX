import { describe, expect, it } from 'vitest';
import type { AgentPreflightView } from 'shared/types';

import {
  overlayAuthPreflightItems,
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

  it('keeps a later auth refresh when a full preflight finishes', () => {
    const full: AgentPreflightView = {
      agent_id: 'claude_code',
      checked_at: '2026-09-08T00:00:00Z',
      items: [
        {
          id: 'acp',
          label: 'ACP 适配器',
          status: 'pass',
          detail: '',
          version: '1.0.0',
          path: '/usr/local/bin/claude-acp',
          source: null,
          repairable: true,
          update_available: false,
          available_version: null,
          update_group: null,
        },
        {
          id: 'authentication',
          label: '鉴权',
          status: 'fail',
          detail: '当前鉴权模式 `official_subscription` 尚未就绪。',
          version: 'official_subscription',
          path: null,
          source: null,
          repairable: true,
          update_available: false,
          available_version: null,
          update_group: null,
        },
      ],
    };
    const refreshed: AgentPreflightView = {
      ...full,
      checked_at: '2026-09-08T00:01:00Z',
      items: [
        {
          ...full.items[1],
          status: 'pass',
          detail: '',
          version: 'model_provider',
        },
      ],
    };
    const next = overlayAuthPreflightItems(full, refreshed);
    expect(next.items.find((item) => item.id === 'acp')?.status).toBe('pass');
    expect(
      next.items.find((item) => item.id === 'authentication')
    ).toMatchObject({
      status: 'pass',
      version: 'model_provider',
    });
  });
});
