import { describe, expect, it } from 'vitest';

import type { LocalToolStatus, SystemMaintenanceStatus } from '@/lib/api';
import {
  getLocalDependencyUpdatePromptTools,
  shouldShowAppUpdateToast,
  shouldStartSystemMaintenance,
  type AppMaintenanceConfig,
} from './appMaintenancePlan';

const config: AppMaintenanceConfig = {
  disclaimer_acknowledged: true,
  auto_update_enabled: true,
  auto_install_local_dependencies: true,
};

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

function status(
  overrides: Partial<SystemMaintenanceStatus> = {}
): SystemMaintenanceStatus {
  return {
    app: {
      current_version: '1.0.0',
      latest_version: '1.1.0',
      update_available: false,
      release_url: null,
      repository: null,
      checked: true,
      error: null,
    },
    npm: {
      name: 'node',
      available: true,
      path: 'C:/node/node.exe',
      message: 'ok',
    },
    tools: [],
    ...overrides,
  };
}

describe('app maintenance plan', () => {
  it('starts maintenance only after config is ready, disclaimer is accepted, and a maintenance lane is enabled', () => {
    expect(
      shouldStartSystemMaintenance({ config: null, hasStarted: false })
    ).toBe(false);
    expect(
      shouldStartSystemMaintenance({ config, hasStarted: true })
    ).toBe(false);
    expect(
      shouldStartSystemMaintenance({
        config: { ...config, disclaimer_acknowledged: false },
        hasStarted: false,
      })
    ).toBe(false);
    expect(
      shouldStartSystemMaintenance({
        config: {
          ...config,
          auto_update_enabled: false,
          auto_install_local_dependencies: false,
        },
        hasStarted: false,
      })
    ).toBe(false);
    expect(
      shouldStartSystemMaintenance({ config, hasStarted: false })
    ).toBe(true);
  });

  it('shows the app update toast only when update checks are enabled and an update is available', () => {
    expect(
      shouldShowAppUpdateToast({
        config,
        status: status({
          app: {
            ...status().app,
            update_available: true,
          },
        }),
      })
    ).toBe(true);
    expect(
      shouldShowAppUpdateToast({
        config: null,
        status: status({
          app: {
            ...status().app,
            update_available: true,
          },
        }),
      })
    ).toBe(false);
    expect(
      shouldShowAppUpdateToast({
        config: { ...config, auto_update_enabled: false },
        status: status({
          app: {
            ...status().app,
            update_available: true,
          },
        }),
      })
    ).toBe(false);
    expect(
      shouldShowAppUpdateToast({
        config,
        status: status({
          app: {
            ...status().app,
            update_available: false,
          },
        }),
      })
    ).toBe(false);
  });

  it('prompts only for visible local tools that need installation or supported-version updates', () => {
    const missingVisible = tool({ id: 'missing', installed: false });
    const staleVisible = tool({
      id: 'stale',
      installed_version: '0.9.0',
      minimum_supported_version: '1.0.0',
    });
    const hiddenMissing = tool({
      id: 'hidden',
      user_visible: false,
      installed: false,
    });
    const currentVisible = tool({ id: 'current' });

    expect(
      getLocalDependencyUpdatePromptTools({
        config,
        tools: [missingVisible, staleVisible, hiddenMissing, currentVisible],
      }).map((item) => item.id)
    ).toEqual(['missing', 'stale']);
    expect(
      getLocalDependencyUpdatePromptTools({
        config: null,
        tools: [missingVisible, staleVisible],
      })
    ).toEqual([]);
    expect(
      getLocalDependencyUpdatePromptTools({
        config: { ...config, auto_install_local_dependencies: false },
        tools: [missingVisible, staleVisible],
      })
    ).toEqual([]);
  });
});
