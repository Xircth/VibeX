import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import type {
  AppUpdateLifecycleState,
  AppUpdateSnapshot,
} from '@/lib/appUpdate';
import { UpdateAvailableBadge } from './UpdateAvailableBadge';

const mocks = vi.hoisted(() => {
  const snapshotListeners = new Set<(s: AppUpdateSnapshot) => void>();
  const stateListeners = new Set<(s: AppUpdateLifecycleState) => void>();
  const dismissedListeners = new Set<(v: string | null) => void>();

  return {
    autoUpdateEnabled: true,
    cachedSnapshot: null as AppUpdateSnapshot | null,
    lifecycleState: {
      status: 'idle',
      version: null,
      downloaded: 0,
      total: null,
      error: null,
    } as AppUpdateLifecycleState,
    dismissedVersion: null as string | null,
    snapshotListeners,
    stateListeners,
    dismissedListeners,
    checkAppUpdate: vi.fn(),
    startAppUpdate: vi.fn(),
    relaunchApp: vi.fn(),
    dismissAppUpdateVersion: vi.fn((version: string | null) => {
      mocks.dismissedVersion = version;
      for (const listener of dismissedListeners) listener(version);
    }),
    emitState: (next: Partial<AppUpdateLifecycleState>) => {
      mocks.lifecycleState = { ...mocks.lifecycleState, ...next };
      for (const listener of stateListeners) listener(mocks.lifecycleState);
    },
  };
});

vi.mock('@/lib/appUpdate', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/appUpdate')>('@/lib/appUpdate');
  return {
    ...actual,
    checkAppUpdate: mocks.checkAppUpdate,
    readCachedAppUpdate: () => mocks.cachedSnapshot,
    subscribeAppUpdate: (listener: (s: AppUpdateSnapshot) => void) => {
      mocks.snapshotListeners.add(listener);
      return () => mocks.snapshotListeners.delete(listener);
    },
    getAppUpdateState: () => mocks.lifecycleState,
    subscribeAppUpdateState: (
      listener: (s: AppUpdateLifecycleState) => void
    ) => {
      mocks.stateListeners.add(listener);
      return () => mocks.stateListeners.delete(listener);
    },
    getDismissedAppUpdateVersion: () => mocks.dismissedVersion,
    dismissAppUpdateVersion: mocks.dismissAppUpdateVersion,
    subscribeDismissedAppUpdateVersion: (
      listener: (v: string | null) => void
    ) => {
      mocks.dismissedListeners.add(listener);
      return () => mocks.dismissedListeners.delete(listener);
    },
    startAppUpdate: mocks.startAppUpdate,
    installSignedUpdate: mocks.startAppUpdate,
    relaunchApp: mocks.relaunchApp,
  };
});

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    config: { auto_update_enabled: mocks.autoUpdateEnabled },
  }),
}));

vi.mock('@/components/NormalizedConversation/AstryxMarkdown', () => ({
  AstryxMarkdown: ({ value }: { value: string }) => <div>{value}</div>,
}));

const sampleSnapshot: AppUpdateSnapshot = {
  currentVersion: '0.37.0',
  lastCheckedAt: Date.parse('2026-10-22T08:00:00.000Z'),
  checked: true,
  error: null,
  update: {
    version: '0.39.0',
    body: '## 中文\n\n- 修复状态栏更新提示',
    date: '2026-10-22T00:00:00.000Z',
    releaseUrl: 'https://github.com/Xircth/VibeX/releases/tag/v0.39.0',
    canInstall: true,
  },
};

describe('UpdateAvailableBadge', () => {
  beforeEach(async () => {
    if (i18n.language !== 'zh-CN') {
      await i18n.changeLanguage('zh-CN');
    }
    mocks.autoUpdateEnabled = true;
    mocks.cachedSnapshot = null;
    mocks.dismissedVersion = null;
    mocks.lifecycleState = {
      status: 'idle',
      version: null,
      downloaded: 0,
      total: null,
      error: null,
    };
    mocks.snapshotListeners.clear();
    mocks.stateListeners.clear();
    mocks.dismissedListeners.clear();
    mocks.checkAppUpdate.mockReset();
    mocks.startAppUpdate.mockReset();
    mocks.relaunchApp.mockReset();
    mocks.dismissAppUpdateVersion.mockClear();
    mocks.checkAppUpdate.mockResolvedValue({
      currentVersion: '0.37.0',
      lastCheckedAt: Date.now(),
      checked: true,
      error: null,
      update: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not check when automatic updates are disabled', async () => {
    mocks.autoUpdateEnabled = false;

    render(<UpdateAvailableBadge />);
    await Promise.resolve();

    expect(mocks.checkAppUpdate).not.toHaveBeenCalled();
  });

  it('uses the shared update check when automatic updates are on', async () => {
    mocks.checkAppUpdate.mockResolvedValue(sampleSnapshot);

    render(<UpdateAvailableBadge />);

    await waitFor(() => expect(mocks.checkAppUpdate).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole('button', { name: '新版本 v0.39.0' })
    ).toBeVisible();
  });

  it('opens the update popover with release notes and starts update inline', async () => {
    const user = userEvent.setup();
    mocks.cachedSnapshot = sampleSnapshot;
    mocks.checkAppUpdate.mockResolvedValue(sampleSnapshot);

    render(<UpdateAvailableBadge />);

    const trigger = await screen.findByRole('button', {
      name: '新版本 v0.39.0',
    });
    await user.click(trigger);

    expect(await screen.findByText('发现新版本')).toBeVisible();
    expect(screen.getByText('v0.37.0 → v0.39.0')).toBeVisible();
    expect(screen.getByText('更新内容')).toBeVisible();
    expect(screen.getByText(/修复状态栏更新提示/)).toBeVisible();

    const upgradeBtn = screen.getByRole('button', { name: '升级到 v0.39.0' });
    await user.click(upgradeBtn);
    expect(mocks.startAppUpdate).toHaveBeenCalledOnce();
  });

  it('collapses to a muted icon when Later is clicked', async () => {
    const user = userEvent.setup();
    mocks.cachedSnapshot = sampleSnapshot;
    mocks.checkAppUpdate.mockResolvedValue(sampleSnapshot);

    render(<UpdateAvailableBadge />);

    const trigger = await screen.findByRole('button', {
      name: '新版本 v0.39.0',
    });
    await user.click(trigger);

    await user.click(await screen.findByRole('button', { name: '稍后' }));

    expect(mocks.dismissAppUpdateVersion).toHaveBeenCalledWith('0.39.0');
    const mutedBtn = screen.getByRole('button', { name: '新版本 v0.39.0' });
    expect(mutedBtn.textContent).toBe('');
  });

  it('shows step rail, progress bar, and bytes while downloading and restarts when ready', async () => {
    const user = userEvent.setup();
    mocks.cachedSnapshot = sampleSnapshot;
    mocks.checkAppUpdate.mockResolvedValue(sampleSnapshot);
    mocks.lifecycleState = {
      status: 'downloading',
      version: '0.39.0',
      downloaded: 1024,
      total: 4096,
      error: null,
    };

    render(<UpdateAvailableBadge />);

    const trigger = await screen.findByRole('button', {
      name: '下载中... 25%',
    });
    await user.click(trigger);

    expect(await screen.findByText('应用升级')).toBeVisible();
    expect(screen.getByText('下载')).toBeVisible();
    expect(screen.getByText('安装')).toBeVisible();
    expect(screen.getByText('重启')).toBeVisible();
    expect(screen.getByText('1.0 KB / 4.0 KB')).toBeVisible();

    act(() => {
      mocks.emitState({
        status: 'ready_to_restart',
        downloaded: 4096,
        total: 4096,
      });
    });

    const restartButtons = await screen.findAllByRole('button', {
      name: '重启以更新',
    });
    await user.click(restartButtons[restartButtons.length - 1]);
    expect(mocks.relaunchApp).toHaveBeenCalledOnce();
  });
});
