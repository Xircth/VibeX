import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  commandRegistry,
  defineVibeXPlugin,
  disposePluginRegistrations,
  globalServices,
  providerRegistry,
  slotRegistry,
} from '@vibex/plugin-sdk';
import { createContext, useContext } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPluginCrashState,
  isPluginQuarantined,
  setPluginQuarantineHandler,
} from './PluginBoundary';
import { Slot } from './Slot';
import {
  loadPluginRuntime,
  unloadPluginRuntime,
} from '@/features/plugins/PluginRuntimeLoader';

const HostTestContext = createContext<string>('missing-context');
const HostThemeContext = createContext<{ mode: 'light' | 'dark' }>({
  mode: 'light',
});
const HostI18nContext = createContext<(key: string) => string>((key) => key);

function useHostTranslation() {
  const t = useContext(HostI18nContext);
  return { t };
}

describe('PluginBoundary & Slot same-tree architecture', () => {
  beforeEach(() => {
    clearPluginCrashState();
    slotRegistry.clear();
    commandRegistry.clear();
    providerRegistry.clear();
    globalServices.clear();
  });

  afterEach(() => {
    act(() => {
      clearPluginCrashState();
      setPluginQuarantineHandler(null);
      act(() => {
        unloadPluginRuntime('acme.demo');
      });
      unloadPluginRuntime('acme.crasher');
      disposePluginRegistrations('acme.demo');
      disposePluginRegistrations('acme.crasher');
      disposePluginRegistrations('acme.healthy');
    });
  });

  it('renders plugin slot components inside the same React Context tree without a separate root', async () => {
    const plugin = defineVibeXPlugin({
      id: 'acme.demo',
      activate(ctx) {
        ctx.registerSlot({
          id: 'status-chip',
          slot: 'status.bar',
          order: 10,
          component: function StatusChipProbe() {
            const hostValue = useContext(HostTestContext);
            const theme = useContext(HostThemeContext);
            const { t } = useHostTranslation();
            return (
              <span data-testid="plugin-chip" data-theme={theme.mode}>
                {t('greeting')}: {hostValue} ({theme.mode})
              </span>
            );
          },
        });
      },
    });

    await loadPluginRuntime('acme.demo', {
      kind: 'module',
      module: plugin,
      css: '.plugin-chip { color: green; }',
    });

    render(
      <HostThemeContext.Provider value={{ mode: 'dark' }}>
        <HostI18nContext.Provider
          value={(k) => (k === 'greeting' ? 'Host says' : k)}
        >
          <HostTestContext.Provider value="shared-react-tree-ok">
            <Slot name="status.bar" />
          </HostTestContext.Provider>
        </HostI18nContext.Provider>
      </HostThemeContext.Provider>
    );

    expect(screen.getByTestId('plugin-chip')).toHaveTextContent(
      'Host says: shared-react-tree-ok (dark)'
    );
    expect(screen.getByTestId('plugin-chip')).toHaveAttribute(
      'data-theme',
      'dark'
    );
    const styleEl = document.head.querySelector(
      'style[data-vibex-plugin="acme.demo"]'
    );
    expect(styleEl?.textContent).toContain('@layer vibex-plugins');

    act(() => {
      unloadPluginRuntime('acme.demo');
    });
    expect(
      document.head.querySelector('style[data-vibex-plugin="acme.demo"]')
    ).toBeNull();
  });

  it('isolates crashing plugins and auto-quarantines after 3 crashes while keeping sibling plugins alive', () => {
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const quarantinedSpy = vi.fn();
    setPluginQuarantineHandler(quarantinedSpy);

    slotRegistry.register('acme.healthy:chip', {
      id: 'acme.healthy:chip',
      pluginId: 'acme.healthy',
      slot: 'toolbar.actions',
      order: 1,
      component: () => <div data-testid="healthy-plugin">Healthy</div>,
    });

    slotRegistry.register('acme.crasher:chip', {
      id: 'acme.crasher:chip',
      pluginId: 'acme.crasher',
      slot: 'toolbar.actions',
      order: 2,
      component: () => {
        throw new Error('boom from crasher');
      },
    });

    commandRegistry.register('acme.crasher:cmd', {
      id: 'acme.crasher:cmd',
      pluginId: 'acme.crasher',
      title: 'Crasher Command',
      handler: () => undefined,
    });

    render(<Slot name="toolbar.actions" />);

    // Crash #1: sibling stays healthy, fallback shown with Retry button
    expect(screen.getByTestId('healthy-plugin')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-boundary-fallback')).toHaveAttribute(
      'data-quarantined',
      'false'
    );
    expect(isPluginQuarantined('acme.crasher')).toBe(false);

    // Retry -> Crash #2
    fireEvent.click(screen.getByTestId('plugin-boundary-retry'));
    expect(isPluginQuarantined('acme.crasher')).toBe(false);

    // Retry -> Crash #3 -> triggers auto-quarantine and disposes all registrations
    fireEvent.click(screen.getByTestId('plugin-boundary-retry'));
    expect(isPluginQuarantined('acme.crasher')).toBe(true);
    expect(quarantinedSpy).toHaveBeenCalledWith(
      'acme.crasher',
      expect.any(Error)
    );
    // All registrations of the quarantined plugin are automatically revoked
    expect(commandRegistry.has('acme.crasher:cmd')).toBe(false);
    expect(slotRegistry.has('acme.crasher:chip')).toBe(false);
    // Healthy sibling plugin remains untouched
    expect(screen.getByTestId('healthy-plugin')).toBeInTheDocument();

    spyError.mockRestore();
  });

  it('loads Tier-0 declarative plugins into provider and command registries', async () => {
    const dispose = await loadPluginRuntime('acme.demo', {
      kind: 'declarative',
      spec: {
        providers: [
          {
            id: 'deepseek',
            label: 'DeepSeek',
            baseUrl: 'https://api.deepseek.com',
          },
        ],
        commands: [
          {
            id: 'ping',
            title: 'Ping Demo',
          },
        ],
      },
    });

    expect(providerRegistry.has('acme.demo:deepseek')).toBe(true);
    expect(commandRegistry.has('acme.demo:ping')).toBe(true);

    dispose();
    expect(providerRegistry.has('acme.demo:deepseek')).toBe(false);
    expect(commandRegistry.has('acme.demo:ping')).toBe(false);
  });
});
