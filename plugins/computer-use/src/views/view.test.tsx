import path from 'node:path';
import { createRequire } from 'node:module';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ComputerUseSettingsView, {
  catalogItems,
  resolveBrokerSurface,
  type ComputerStatus,
  type ComputerToolsSettings,
  type DriverInfo,
  type SharedState,
  type StopKeyStatus,
} from './view';

const require = createRequire(import.meta.url);

beforeAll(() => {
  if (typeof document === 'undefined') {
    const jsdomPath = require.resolve('jsdom', {
      paths: [path.resolve(process.cwd(), '../VibeX/frontend/node_modules')],
    });
    const { JSDOM } = require(jsdomPath);
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'http://127.0.0.1/',
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      HTMLButtonElement: dom.window.HTMLButtonElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      HTMLSelectElement: dom.window.HTMLSelectElement,
      Event: dom.window.Event,
      KeyboardEvent: dom.window.KeyboardEvent,
      MouseEvent: dom.window.MouseEvent,
      Node: dom.window.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
  } else {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  }
});

describe('ComputerUseSettingsView with live vibex-computer-helper daemon payloads', () => {
  it('renders enabled state with PermissionReport object, DriverInfo installed array, and activity items without throwing', async () => {
    const liveSettings: ComputerToolsSettings = {
      enabled: true,
      envOverride: null,
      grantTimeoutSecs: 1800,
      stopShortcut: 'Ctrl+Alt+Shift+Period',
      defaultStopShortcut: 'Ctrl+Alt+Shift+Period',
      allowForeground: true,
      defaultDelivery: 'background',
      defaultBlocklist: [
        { key: '1password', name: '1Password', blocked: true },
        { key: 'bitwarden', name: 'Bitwarden', blocked: true },
      ],
      customBlocklist: ['keepass.exe'],
      launchEnabled: true,
      clipboardEnabled: true,
      screenEnabled: true,
      showIndicator: true,
    };

    const liveStatus: ComputerStatus = {
      enabled: true,
      platform: 'windows',
      verifiedPlatform: false,
      backend: {
        driverVersion: '0.32.0',
        peer: 'notApplicable',
        state: 'ready',
      },
      // Exact object shape returned by vibex-computer-helper on Windows
      permissions: {
        required: false,
        accessibility: true,
        screenRecording: true,
      },
      shared: [],
      screenOffered: true,
    };

    const liveSharedState: SharedState = {
      shared: [
        {
          targetId: 'w5',
          pid: 4200,
          appName: 'Notepad',
          title: 'notes.txt - Notepad',
          level: 'control',
        },
      ],
      apps: [],
      screen: null,
    };

    const liveStopKey: StopKeyStatus = {
      active: 'Ctrl+Alt+Shift+Period',
      failed: null,
      detail: null,
    };

    const liveDriverInfo: DriverInfo = {
      version: '0.32.0',
      supported: true,
      installed: ['0.32.0'],
      path: 'C:\\Users\\test\\AppData\\Local\\vibex\\acp-binaries\\@cua-driver\\0.32.0\\cua-driver.exe',
    };

    const invokeMock = vi.fn(
      async (handler: string, input?: Record<string, unknown> | null) => {
        const method = (input?.rpcMethod as string) ?? handler;
        switch (method) {
          case 'computer.snapshotState':
            return {
              settings: liveSettings,
              status: liveStatus,
              sharedState: liveSharedState,
              stopKeyStatus: liveStopKey,
              driverInfo: liveDriverInfo,
              activity: [
                {
                  targetId: 'w5',
                  app: 'Notepad',
                  action: 'snapshot',
                  outcome: 'done',
                  at: Date.now() - 12_000,
                },
              ],
            };
          case 'computer.getSettings':
            return liveSettings;
          case 'computer.status':
            return liveStatus;
          case 'computer.sharedState':
            return liveSharedState;
          case 'computer.stopKeyStatus':
            return liveStopKey;
          case 'computer.driverInfo':
            return liveDriverInfo;
          case 'computer.activity':
            return [
              {
                targetId: 'w5',
                app: 'Notepad',
                action: 'snapshot',
                outcome: 'done',
                at: Date.now() - 12_000,
              },
            ];
          case 'computer.listWindows':
            return [
              {
                targetId: 'w5',
                windowId: 1001,
                pid: 4200,
                appName: 'Notepad',
                appId: 'notepad.exe',
                title: 'notes.txt - Notepad',
                bounds: { x: 100, y: 100, width: 800, height: 600 },
                minimized: false,
                hidden: false,
                notGrantable: null,
                level: 'control',
              },
              {
                targetId: 'w9',
                windowId: 1002,
                pid: 13080,
                appName: 'vibex',
                appId: 'vibex.exe',
                title: '设置',
                bounds: { x: 548, y: 424, width: 1929, height: 1404 },
                minimized: false,
                hidden: false,
                notGrantable: 'vibex',
                level: 'none',
              },
            ];
          case 'computer.listLocalApps':
            return [
              {
                name: '微信',
                identifier: 'Weixin.exe',
                exeName: 'Weixin.exe',
                path: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
                running: true,
              },
              {
                name: 'Telegram Desktop',
                identifier: 'Telegram.exe',
                exeName: 'Telegram.exe',
                path: 'C:\\Users\\test\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe',
                running: false,
              },
            ];
          default:
            return {};
        }
      }
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ComputerUseSettingsView, {
          environment: {
            pluginId: 'vibex-plugin-computer-use',
            surfaceId: 'computer-use',
            slot: 'settings.page',
            invoke: invokeMock,
          },
        })
      );
    });

    expect(container.textContent).toContain('电脑控制');
    expect(container.textContent).toContain('已就绪 · 1 项共享');
    expect(container.textContent).toContain('已安装');
    expect(container.textContent).toContain('能力设置');
    expect(container.textContent).not.toContain('授权时效与紧急停止快捷键');
    expect(container.textContent).not.toContain('输入投递方式与扩展能力');
    expect(container.textContent).toContain('拒绝共享应用名单');
    expect(container.textContent).toContain('1Password');
    expect(container.textContent).toContain('Bitwarden');
    expect(container.textContent).toContain('keepass.exe');
    expect(container.textContent).toContain('notes.txt - Notepad');
    expect(container.textContent).toContain('无障碍快照');

    // Verify "显示桌面共享状态指示条" appears AFTER "全局紧急停止快捷键"
    const fullText = container.textContent ?? '';
    const stopShortcutIdx = fullText.indexOf('全局紧急停止快捷键');
    const showIndicatorIdx = fullText.indexOf('显示桌面共享状态指示条');
    expect(stopShortcutIdx).toBeGreaterThan(-1);
    expect(showIndicatorIdx).toBeGreaterThan(stopShortcutIdx);

    // Verify SettingsSelect combobox opens .astryx-select-menu.tahoe-popover and selects an option
    const ttlCombobox = container.querySelector(
      '[role="combobox"][aria-label="共享闲置自动过期时间"]'
    ) as HTMLElement | null;
    expect(ttlCombobox).not.toBeNull();
    expect(ttlCombobox?.className).toContain('astryx-selector');
    expect(ttlCombobox?.className).not.toContain('xcr08ib');
    expect(ttlCombobox?.className).not.toContain('xdk3u5w');
    expect(ttlCombobox?.style.fontSize).toBe('12px');
    expect(ttlCombobox?.textContent).toContain('30 分钟（默认）');

    const deliveryCombobox = container.querySelector(
      '[role="combobox"][aria-label="默认输入投递模式"]'
    ) as HTMLElement | null;
    expect(deliveryCombobox).not.toBeNull();
    expect(deliveryCombobox?.className).not.toContain('xcr08ib');
    expect(deliveryCombobox?.style.fontSize).toBe('12px');

    const rowLabels = Array.from(
      container.querySelectorAll('.settings-row label:not(.astryx-field-label)')
    ) as HTMLElement[];
    expect(rowLabels.length).toBeGreaterThanOrEqual(3);
    for (const lbl of rowLabels) {
      expect(lbl.className).toContain('text-sm');
      expect(lbl.style.fontSize).toBe('');
    }

    await act(async () => {
      ttlCombobox?.click();
    });

    const listbox = container.querySelector(
      '[role="listbox"][aria-label="共享闲置自动过期时间"]'
    ) as HTMLElement | null;
    expect(listbox).not.toBeNull();
    expect(listbox?.className).toContain('astryx-select-menu');
    expect(listbox?.className).toContain('tahoe-popover');
    expect(listbox?.style.fontSize).toBe('12px');

    const oneHourOption = Array.from(
      listbox?.querySelectorAll('[role="option"]') ?? []
    ).find((el) => el.textContent?.includes('1 小时')) as HTMLElement | undefined;
    expect(oneHourOption).toBeDefined();
    expect(oneHourOption?.className).not.toContain('xcr08ib');
    expect(oneHourOption?.style.fontSize).toBe('12px');

    await act(async () => {
      oneHourOption?.click();
    });

    expect(ttlCombobox?.textContent).toContain('1 小时');

    // Verify LocalAppPickerModal opens when clicking "选择应用..."
    const pickAppBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('选择应用...')
    );
    expect(pickAppBtn).toBeDefined();

    await act(async () => {
      pickAppBtn?.click();
    });

    const appPickerDialog = container.querySelector(
      '[role="dialog"][aria-label="选择本机拒绝共享的应用"]'
    ) as HTMLElement | null;
    expect(appPickerDialog).not.toBeNull();
    expect(appPickerDialog?.textContent).toContain('微信');
    expect(appPickerDialog?.textContent).toContain('Weixin.exe');
    expect(
      appPickerDialog?.querySelector('.astryx-text-input')
    ).not.toBeNull();

    const closeAppPickerBtn = Array.from(
      appPickerDialog?.querySelectorAll('button') ?? []
    ).find((btn) => btn.textContent?.trim() === '取消');
    expect(closeAppPickerBtn?.className).toContain('astryx-button');
    await act(async () => {
      closeAppPickerBtn?.click();
    });

    // Verify WindowPickerModal opens with .dialog-surface and bounded maxHeight
    const openPickerBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('选择共享窗口')
    );
    expect(openPickerBtn).toBeDefined();

    await act(async () => {
      openPickerBtn?.click();
    });

    const dialogSurface = container.querySelector(
      '[role="dialog"].dialog-surface'
    ) as HTMLElement | null;
    expect(dialogSurface).not.toBeNull();
    expect(dialogSurface?.style.maxHeight).toBe('min(78vh, 620px)');
    expect(dialogSurface?.style.overflow).toBe('hidden');
    expect(dialogSurface?.querySelector('.astryx-text-input')).not.toBeNull();
    const doneBtn = Array.from(
      dialogSurface?.querySelectorAll('button') ?? []
    ).find((btn) => btn.textContent?.trim() === '完成');
    expect(doneBtn?.className).toContain('astryx-button');
    expect(doneBtn?.className).toContain('primary');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('formats plain-object Tauri invoke errors instead of rendering [object Object]', async () => {
    const invokeMock = vi.fn(
      async (handler: string, input?: Record<string, unknown> | null) => {
        const method = (input?.rpcMethod as string) ?? handler;
        if (method === 'computer.setEnabled') {
          return Promise.reject({
            code: 'conflict',
            message: 'App surface session is missing or expired',
          });
        }
        return {};
      }
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ComputerUseSettingsView, {
          environment: {
            pluginId: 'vibex-plugin-computer-use',
            surfaceId: 'computer-use',
            slot: 'settings.page',
            invoke: invokeMock,
          },
        })
      );
    });

    const enableSwitch = container.querySelector(
      'button[role="switch"][aria-label="启用电脑控制"]'
    ) as HTMLButtonElement | null;
    expect(enableSwitch).not.toBeNull();

    await act(async () => {
      enableSwitch?.click();
    });

    expect(container.textContent).not.toContain('[object Object]');
    expect(container.textContent).toContain(
      'App surface session is missing or expired'
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('mounts and renders against the real worker and vibex-computer-helper daemon', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const { createWorkerHarness } = await import('@vibex/plugin-sdk/testing');
    const workerModule = await import('../../runtime/worker.mjs');

    const tempDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'vibex-computer-view-e2e-')
    );
    process.env.VIBEX_PLUGIN_DATA_DIR = tempDataDir;

    const worker = await createWorkerHarness(workerModule.default);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await worker.invoke('surface.createSession', {
        rpcMethod: 'computer.setEnabled',
        rpcParams: { enabled: true },
      });

      await act(async () => {
        root.render(
          React.createElement(ComputerUseSettingsView, {
            environment: {
              pluginId: 'vibex-plugin-computer-use',
              surfaceId: 'computer-use',
              slot: 'settings.page',
              invoke: (handler: string, input?: Record<string, unknown> | null) =>
                worker.invoke(handler, input ?? {}),
            },
          })
        );
      });

      // Wait for async refreshLiveState to settle
      for (let i = 0; i < 10; i += 1) {
        if (container.textContent?.includes('服务开关与实时共享')) break;
        await act(async () => {
          await new Promise((r) => setTimeout(r, 100));
        });
      }

      expect(container.textContent).toContain('电脑控制');
      expect(container.textContent).toContain('服务开关与实时共享');
      expect(container.textContent).toContain('驱动与系统权限');
      expect(container.textContent).toContain('能力设置');
      expect(container.textContent).toContain('拒绝共享应用名单');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      await worker.dispose();
    }
  });
});

describe('status popover Worker broker', () => {
  const pluginId = 'vibex-plugin-computer-use';

  it('reads catalog items from the host object or a bare array', () => {
    expect(
      catalogItems({
        generation: 4,
        items: [{ pluginId, id: 'computer-use', kind: 'settings_page', generation: 4 }],
      })
    ).toEqual([
      { pluginId, id: 'computer-use', kind: 'settings_page', generation: 4 },
    ]);
    expect(
      catalogItems([{ pluginId, id: 'computer-use', kind: 'settings_page', generation: 2 }])
    ).toHaveLength(1);
    expect(catalogItems(null)).toEqual([]);
    expect(catalogItems({ items: 'nope' })).toEqual([]);
  });

  it('binds a status id to the sibling settings page and its generation', () => {
    const broker = resolveBrokerSurface(
      [
        { pluginId, id: 'computer-use-status', kind: 'status', generation: 1 },
        { pluginId: 'other', id: 'computer-use', kind: 'settings_page', generation: 9 },
        { pluginId, id: 'console', kind: 'app_tab', generation: 3 },
        { pluginId, id: 'computer-use', kind: 'settings_page', generation: 6 },
      ],
      pluginId,
      'computer-use-status'
    );
    expect(broker).toEqual({ id: 'computer-use', generation: 6 });
  });

  it('keeps an id that is already an openable surface', () => {
    expect(
      resolveBrokerSurface(
        [
          { pluginId, id: 'computer-use', kind: 'settings_page', generation: 8 },
          { pluginId, id: 'older', kind: 'app_panel', generation: 2 },
        ],
        pluginId,
        'computer-use'
      )
    ).toEqual({ id: 'computer-use', generation: 8 });
  });

  it('falls back to the requested id when the plugin has no openable surface', () => {
    expect(
      resolveBrokerSurface(
        [{ pluginId, id: 'computer-use-status', kind: 'status', generation: 5 }],
        pluginId,
        'computer-use-status'
      )
    ).toEqual({ id: 'computer-use-status', generation: 5 });
    expect(resolveBrokerSurface([], pluginId, 'computer-use-status')).toEqual({
      id: 'computer-use-status',
      generation: 1,
    });
  });
});

