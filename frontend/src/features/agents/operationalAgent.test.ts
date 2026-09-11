import { describe, expect, it } from 'vitest';

import { isEnabledInstalledAgent } from './operationalAgent';

describe('isEnabledInstalledAgent', () => {
  it('includes an enabled ready Agent', () => {
    expect(isEnabledInstalledAgent({ enabled: true, lifecycle: 'ready' })).toBe(
      true
    );
  });

  it('includes an enabled Agent that still needs authentication', () => {
    expect(
      isEnabledInstalledAgent({ enabled: true, lifecycle: 'needs_auth' })
    ).toBe(true);
  });

  it('includes an enabled Agent that needs configuration or repair', () => {
    expect(
      isEnabledInstalledAgent({ enabled: true, lifecycle: 'needs_config' })
    ).toBe(true);
    expect(
      isEnabledInstalledAgent({ enabled: true, lifecycle: 'needs_repair' })
    ).toBe(true);
  });

  it('excludes an enabled but uninstalled Agent', () => {
    expect(
      isEnabledInstalledAgent({ enabled: true, lifecycle: 'uninstalled' })
    ).toBe(false);
  });

  it('excludes a disabled installed Agent', () => {
    expect(
      isEnabledInstalledAgent({ enabled: false, lifecycle: 'ready' })
    ).toBe(false);
  });

  it('still includes enabled Agents that are installing or updating', () => {
    expect(
      isEnabledInstalledAgent({ enabled: true, lifecycle: 'installing' })
    ).toBe(true);
    expect(
      isEnabledInstalledAgent({ enabled: true, lifecycle: 'updating' })
    ).toBe(true);
  });
});
