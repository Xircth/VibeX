import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import { AppUpdaterSection } from './AppUpdaterSection';

const mocks = vi.hoisted(() => ({
  snapshot: {
    currentVersion: '0.1.2',
    lastCheckedAt: Date.parse('2026-08-18T08:30:00.000Z'),
    checked: true,
    error: null,
    update: {
      version: '0.1.3',
      body: '## English\n\nEnglish notes\n\n## 中文\n\n中文更新说明',
      date: '2026-08-16T00:00:00.000Z',
      releaseUrl: 'https://github.com/Xircth/VibeX/releases/tag/v0.1.3',
      canInstall: true,
    },
  },
  checkAppUpdate: vi.fn(),
  installSignedUpdate: vi.fn(),
  relaunchApp: vi.fn(),
}));

vi.mock('@/lib/appUpdate', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/appUpdate')>('@/lib/appUpdate');
  return {
    ...actual,
    CHECK_TTL_MS: 6 * 60 * 60 * 1000,
    checkAppUpdate: mocks.checkAppUpdate,
    installSignedUpdate: mocks.installSignedUpdate,
    readCachedAppUpdate: () => mocks.snapshot,
    relaunchApp: mocks.relaunchApp,
    subscribeAppUpdate: () => () => undefined,
  };
});

vi.mock('@/components/NormalizedConversation/AstryxMarkdown', () => ({
  AstryxMarkdown: ({ value }: { value: string }) => <div>{value}</div>,
}));

describe('AppUpdaterSection', () => {
  beforeEach(async () => {
    mocks.checkAppUpdate.mockReset();
    mocks.checkAppUpdate.mockResolvedValue(mocks.snapshot);
    if (i18n.language !== 'zh-CN') {
      await i18n.changeLanguage('zh-CN');
    }
  });

  it('shows last checked time and localized release notes', async () => {
    render(
      <AppUpdaterSection
        autoUpdateEnabled
        onAutoUpdateChange={() => undefined}
      />
    );

    expect(await screen.findByText(/当前版本 v0.1.2/)).toBeVisible();
    expect(screen.getByText(/上次检查/)).toBeVisible();
    expect(screen.getByText('更新日志')).toBeVisible();
    expect(screen.getByText(/中文更新说明/)).toBeVisible();
    expect(screen.queryByText(/English notes/)).toBeNull();
    expect(screen.getByRole('button', { name: '下载并安装' })).toBeVisible();
  });
});
