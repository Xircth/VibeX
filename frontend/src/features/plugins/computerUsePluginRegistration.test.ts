import { describe, expect, it, vi } from 'vitest';

// Regression: the computer-use status item used to be registered as a slot
// *component*, so <Slot name="status.after-mcp" /> rendered the full window
// picker (view.tsx status branch) inline on every screen, including the
// start/welcome page. The status item must be a plain button whose UI comes
// from the registered popover view.
describe('computer-use plugin registration', () => {
  it('registers the status item without an inline component', async () => {
    const statusItems: Array<Record<string, unknown>> = [];
    const views: Array<Record<string, unknown>> = [];
    const settingsPages: Array<Record<string, unknown>> = [];
    const noop = vi.fn(() => () => undefined);
    const ctx = {
      pluginId: 'vibex-plugin-computer-use',
      worker: { invoke: vi.fn() },
      events: { emit: vi.fn(), on: noop },
      services: { provide: noop },
      ui: new Proxy(
        {
          registerStatusBarItem: (c: Record<string, unknown>) => {
            statusItems.push(c);
            return () => undefined;
          },
          registerView: (c: Record<string, unknown>) => {
            views.push(c);
            return () => undefined;
          },
          registerSettingsPage: (c: Record<string, unknown>) => {
            settingsPages.push(c);
            return () => undefined;
          },
        } as Record<string, unknown>,
        { get: (target, key: string) => target[key] ?? noop }
      ),
    };
    const mod = await import('../../../../plugins/computer-use/app/main.js');
    await mod.default.activate(ctx as never);

    const status = statusItems.find((c) => c.id === 'computer-use-status');
    expect(status).toBeDefined();
    expect(status?.slot).toBe('status.after-mcp');
    expect(status?.component).toBeUndefined();
    expect(status?.render).toBeUndefined();

    // Popover view still available for the status button.
    expect(
      views.some((v) => v.id === 'computer-use-status' && v.component)
    ).toBe(true);
    // No tab view that IDELayout could render as a full-screen overlay.
    expect(views.some((v) => v.kind === 'tab' || v.slot === 'tab.main')).toBe(
      false
    );
    expect(settingsPages.some((p) => p.id === 'computer-use')).toBe(true);
  });
});
