import { describe, expect, it } from 'vitest';

import type { LocalToolStatus } from '@/lib/api';
import {
  compareVersionLike,
  localToolNeedsUpdatePrompt,
} from './appMaintenancePrompt';

function tool(overrides: Partial<LocalToolStatus> = {}): LocalToolStatus {
  return {
    id: 'codex',
    label: 'Codex',
    kind: 'npm',
    group_id: 'agents',
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

describe('maintenance prompt policy', () => {
  it('compares version-like strings numerically with prefixes and missing parts', () => {
    expect(compareVersionLike('v1.10.0', '1.2.0')).toBeGreaterThan(0);
    expect(compareVersionLike('1.2', '1.2.0')).toBe(0);
    expect(compareVersionLike('1.2.0-beta.1', '1.2.0')).toBeGreaterThan(0);
    expect(compareVersionLike('1.0.9', '1.1.0')).toBeLessThan(0);
  });

  it('prompts for missing tools and unsupported installed versions', () => {
    expect(localToolNeedsUpdatePrompt(tool({ installed: false }))).toBe(true);
    expect(
      localToolNeedsUpdatePrompt(
        tool({ installed_version: '0.9.0', minimum_supported_version: '1.0.0' })
      )
    ).toBe(true);
  });

  it('suppresses prompts for supported or version-indeterminate installed tools', () => {
    expect(
      localToolNeedsUpdatePrompt(
        tool({ installed_version: '1.0.0', minimum_supported_version: '1.0.0' })
      )
    ).toBe(false);
    expect(
      localToolNeedsUpdatePrompt(
        tool({ installed_version: '1.1.0', minimum_supported_version: '1.0.0' })
      )
    ).toBe(false);
    expect(
      localToolNeedsUpdatePrompt(
        tool({ installed_version: null, minimum_supported_version: '1.0.0' })
      )
    ).toBe(false);
    expect(
      localToolNeedsUpdatePrompt(
        tool({ installed_version: '1.0.0', minimum_supported_version: null })
      )
    ).toBe(false);
  });
});
