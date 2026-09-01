import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeMode, type Config } from 'shared/types';

import { AppearanceSettings } from './AppearanceSettings';

const mocks = vi.hoisted(() => ({
  config: { theme: 'SYSTEM' as Config['theme'] } as Config,
  updateAndSaveConfig: vi.fn(),
  setTheme: vi.fn(),
  setAppIconStyle: vi.fn(),
  backendEmit: vi.fn(),
  setUiZoom: vi.fn(),
  setMonoFont: vi.fn(),
  setUiLanguage: vi.fn(),
  setLayoutArrangement: vi.fn(),
  setKanbanArrangement: vi.fn(),
  setKanbanSessionListView: vi.fn(),
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    config: mocks.config,
    loading: false,
    updateAndSaveConfig: mocks.updateAndSaveConfig,
  }),
}));

vi.mock('@/components/ThemeProvider', () => ({
  useTheme: () => ({ setTheme: mocks.setTheme, resolvedTheme: 'light' }),
}));

vi.mock('@/lib/appIcon', () => ({
  APP_ICON_STYLES: ['default', 'lite'],
  getAppIconStyle: () => 'default',
  resolveAppLogo: () => '/app-logo-light-default.png',
  setAppIconStyle: mocks.setAppIconStyle,
}));

vi.mock('@/lib/backendTransport', () => ({
  backendEmit: mocks.backendEmit,
}));

vi.mock('@/lib/uiZoom', () => ({
  UI_ZOOM_LEVELS: [1, 1.1],
  getUiZoom: () => 1,
  setUiZoom: mocks.setUiZoom,
}));

vi.mock('@/lib/uiFont', () => ({
  MONO_FONT_OPTIONS: [
    { id: 'plex', label: 'IBM Plex Mono', stack: 'monospace' },
    { id: 'menlo', label: 'Menlo', stack: 'monospace' },
  ],
  getMonoFontId: () => 'plex',
  setMonoFont: mocks.setMonoFont,
}));

vi.mock('@/lib/uiLanguage', () => ({
  LANGUAGE_LABELS: { 'zh-CN': '简体中文', en: 'English' },
  SUPPORTED_LANGUAGES: ['zh-CN', 'en'],
  getUiLanguage: () => 'zh-CN',
}));

vi.mock('@/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/i18n')>()),
  setUiLanguage: mocks.setUiLanguage,
}));

vi.mock('@/lib/layoutArrangement', () => {
  const workspace = {
    left: 'dock',
    center: 'workspace',
    right: 'session',
    bottom: 'terminal',
  };
  const kanban = { left: 'list', center: 'monitor', right: 'session' };
  return {
    arrangementsEqual: (a: object, b: object) =>
      JSON.stringify(a) === JSON.stringify(b),
    useLayoutArrangement: () => workspace,
    useKanbanArrangement: () => kanban,
    setLayoutArrangement: mocks.setLayoutArrangement,
    setKanbanArrangement: mocks.setKanbanArrangement,
  };
});

vi.mock('@/lib/kanbanSessionListView', () => ({
  KANBAN_SESSION_LIST_VIEWS: ['status', 'workspace'],
  getKanbanSessionListView: () => 'status',
  setKanbanSessionListView: mocks.setKanbanSessionListView,
}));

vi.mock('./LayoutArrangementSchematic', () => ({
  WorkspaceLayoutSchematic: () => <div>workspace schematic</div>,
  KanbanLayoutSchematic: () => <div>kanban schematic</div>,
}));

describe('AppearanceSettings', () => {
  beforeEach(() => {
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    for (const value of Object.values(mocks)) {
      if (typeof value === 'function' && 'mockReset' in value) {
        value.mockReset();
      }
    }
    mocks.updateAndSaveConfig.mockResolvedValue(true);
    mocks.backendEmit.mockResolvedValue(undefined);
  });

  it('shows the accent color setting', () => {
    render(<AppearanceSettings />);
    expect(screen.getByRole('heading', { name: '强调色' })).toBeInTheDocument();
  });

  it('applies immediate display preferences and persists the theme on save', async () => {
    const user = userEvent.setup();
    render(<AppearanceSettings />);
    const selects = screen.getAllByRole('combobox');

    await user.click(selects[2]);
    await user.click(screen.getByRole('option', { name: '110%' }));
    expect(mocks.setUiZoom).toHaveBeenCalledWith(1.1);

    await user.click(selects[3]);
    await user.click(screen.getByRole('option', { name: 'Menlo' }));
    expect(mocks.setMonoFont).toHaveBeenCalledWith('menlo');

    await user.click(selects[4]);
    await user.click(screen.getByRole('option', { name: 'English' }));
    expect(mocks.setUiLanguage).toHaveBeenCalledWith('en');

    await user.click(selects[0]);
    await user.click(screen.getByRole('option', { name: 'Dark' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mocks.updateAndSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ theme: ThemeMode.DARK })
      );
    });
    expect(mocks.setTheme).toHaveBeenCalledWith(ThemeMode.DARK);
    expect(mocks.backendEmit).toHaveBeenCalledWith('theme-changed', {
      theme: ThemeMode.DARK,
    });
  });

  it('applies and remembers the selected application icon style', async () => {
    const user = userEvent.setup();
    render(<AppearanceSettings />);

    expect(screen.getByText('应用图标')).toBeInTheDocument();
    const selects = screen.getAllByRole('combobox');
    await user.click(selects[1]);
    await user.click(screen.getByRole('option', { name: '纯标记' }));

    expect(mocks.setAppIconStyle).toHaveBeenCalledWith('lite');
  });

  it('applies the Kanban session list grouping immediately', async () => {
    const user = userEvent.setup();
    render(<AppearanceSettings />);

    expect(screen.getByText('Kanban 会话列表')).toBeInTheDocument();
    const selects = screen.getAllByRole('combobox');
    await user.click(selects[5]);
    await user.click(screen.getByRole('option', { name: '工作区分组视图' }));

    expect(mocks.setKanbanSessionListView).toHaveBeenCalledWith('workspace');
  });
});
