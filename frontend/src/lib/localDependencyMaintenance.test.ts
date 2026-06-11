import { describe, expect, it } from 'vitest';

import type { LocalToolStatus } from '@/lib/api';
import {
  getAgentDependencyTool,
  getLocalDependencyStatusPresentation,
} from './localDependencyMaintenance';

function tool(overrides: Partial<LocalToolStatus> = {}): LocalToolStatus {
  return {
    id: 'codex_cli',
    label: 'Codex CLI',
    kind: 'cli',
    group_id: 'codex',
    user_visible: true,
    executable: 'codex',
    npm_package: '@openai/codex',
    installed: true,
    executable_path: 'C:/tools/codex.cmd',
    installed_version: '1.2.0',
    latest_version: '1.3.0',
    minimum_supported_version: '1.0.0',
    supported: true,
    update_available: false,
    error: null,
    ...overrides,
  };
}

describe('local dependency maintenance helpers', () => {
  it('maps each agent card to its visible maintenance tool', () => {
    const tools = [
      tool({
        id: 'claude_acp',
        group_id: 'claude',
        user_visible: false,
      }),
      tool({
        id: 'claude_cli',
        label: 'Claude Code CLI',
        group_id: 'claude',
      }),
      tool({
        id: 'opencode_cli_acp',
        label: 'OpenCode CLI',
        group_id: 'opencode',
      }),
    ];

    expect(getAgentDependencyTool('claude_code', tools)?.id).toBe('claude_cli');
    expect(getAgentDependencyTool('codex', tools)).toBeNull();
    expect(getAgentDependencyTool('open_code', tools)?.id).toBe(
      'opencode_cli_acp'
    );
    expect(getAgentDependencyTool('unknown', tools)).toBeNull();
  });

  it('derives badge copy and action labels for missing, incompatible, updatable, and current tools', () => {
    expect(
      getLocalDependencyStatusPresentation(
        tool({
          installed: false,
          installed_version: null,
          supported: false,
          update_available: false,
        })
      )
    ).toMatchObject({
      label: '缺失',
      tone: 'destructive',
      actionLabel: '安装',
    });

    expect(
      getLocalDependencyStatusPresentation(
        tool({
          installed_version: '0.9.0',
          minimum_supported_version: '1.0.0',
          supported: false,
        })
      )
    ).toMatchObject({
      label: '版本不兼容',
      tone: 'warning',
      actionLabel: '更新',
    });

    expect(
      getLocalDependencyStatusPresentation(
        tool({
          supported: true,
          update_available: true,
          latest_version: '1.3.0',
        })
      )
    ).toMatchObject({
      label: '可更新',
      tone: 'warning',
      actionLabel: '更新',
    });

    expect(
      getLocalDependencyStatusPresentation(
        tool({
          supported: true,
          update_available: false,
        })
      )
    ).toMatchObject({
      label: '已兼容',
      tone: 'success',
      actionLabel: null,
    });
  });
});
