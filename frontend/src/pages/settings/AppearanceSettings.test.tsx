import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeMode, type Config } from 'shared/types';

import { AppearanceSettings } from './AppearanceSettings';

const mocks = vi.hoisted(() => ({
  config: { theme: 'SYSTEM' as Config['theme'] } as Config,
  updateAndSaveConfig: vi.fn(),
  setTheme: vi.fn(),
  backendEmit: vi.fn(),
  setUiZoom: vi.fn(),
  setMonoFont: vi.fn(),
  setUiLanguage: vi.fn(),
  setLayoutArrangement: vi.fn(),
  setKanbanArrangement: vi.fn(),
  setKanbanSessionListView: vi.fn(),
  setKanbanBoardStyle: vi.fn(),
  setSettingsNavFloat: vi.fn(),
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

vi.mock('@/lib/kanbanBoardStyle', () => ({
  KANBAN_BOARD_STYLES: ['fixed', 'canvas'],
  getKanbanBoardStyle: () => 'fixed',
  setKanbanBoardStyle: mocks.setKanbanBoardStyle,
}));

vi.mock('@/lib/settingsNavFloat', () => ({
  getSettingsNavFloat: () => true,
  setSettingsNavFloat: mocks.setSettingsNavFloat,
  useSettingsNavFloat: () => true,
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

  it('groups accent, zoom, font, and language under basic appearance', () => {
    render(<AppearanceSettings />);
    expect(
      screen.getByRole('heading', { name: '基础外观' })
    ).toBeInTheDocument();
    expect(screen.getByText('强调色')).toBeInTheDocument();
    expect(screen.getByText('缩放比例')).toBeInTheDocument();
    expect(screen.getByText('等宽字体')).toBeInTheDocument();
    expect(screen.getByText('界面语言')).toBeInTheDocument();
    expect(screen.getByText('设置菜单悬浮')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '强调色' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '界面缩放' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '等宽字体' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '语言' })
    ).not.toBeInTheDocument();
  });

  it('does not offer app icon or new-file preview settings', () => {
    render(<AppearanceSettings />);
    expect(screen.queryByText('应用图标')).not.toBeInTheDocument();
    expect(screen.queryByText('新增文件预览')).not.toBeInTheDocument();
    expect(screen.queryByText('自动打开预览')).not.toBeInTheDocument();
  });

  it('renders visual theme choice cards (Light, Dark, System) instead of a combobox', () => {
    render(<AppearanceSettings />);
    const group = screen.getByRole('radiogroup', { name: '应用主题' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Light' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Dark' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'System' })).toBeChecked();
  });

  it('applies immediate display preferences and persists the theme on save', async () => {
    const user = userEvent.setup();
    render(<AppearanceSettings />);
    await user.click(screen.getByRole('combobox', { name: '缩放比例' }));
    const zoomOption = screen.getByRole('option', { name: '110%' });
    expect(zoomOption.querySelector('.astryx-selector-option')).not.toBeNull();
    await user.click(zoomOption);
    expect(mocks.setUiZoom).toHaveBeenCalledWith(1.1);

    await user.click(screen.getByRole('combobox', { name: '等宽字体' }));
    await user.click(screen.getByRole('option', { name: 'Menlo' }));
    expect(mocks.setMonoFont).toHaveBeenCalledWith('menlo');

    await user.click(screen.getByRole('combobox', { name: '界面语言' }));
    await user.click(screen.getByRole('option', { name: 'English' }));
    expect(mocks.setUiLanguage).toHaveBeenCalledWith('en');

    await user.click(screen.getByText('Dark'));
    expect(screen.getByRole('checkbox', { name: 'Dark' })).toBeChecked();
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

  it('groups Kanban session list and board layout under session board style', () => {
    render(<AppearanceSettings />);
    expect(
      screen.getByRole('heading', { name: '会话看板样式' })
    ).toBeInTheDocument();
    expect(screen.getByText('看板会话列表')).toBeInTheDocument();
    expect(screen.getByText('看板布局类型')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Kanban 会话列表' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Kanban 会话列表')).not.toBeInTheDocument();
    expect(screen.queryByText('显示方式')).not.toBeInTheDocument();
    expect(screen.queryByText('看板样式')).not.toBeInTheDocument();
  });

  it('applies the Kanban session list grouping immediately', async () => {
    const user = userEvent.setup();
    render(<AppearanceSettings />);

    await user.click(screen.getByRole('combobox', { name: '看板会话列表' }));
    await user.click(screen.getByRole('option', { name: '工作区分组视图' }));

    expect(mocks.setKanbanSessionListView).toHaveBeenCalledWith('workspace');
  });

  it('applies the session board style immediately', async () => {
    const user = userEvent.setup();
    render(<AppearanceSettings />);

    await user.click(screen.getByRole('combobox', { name: '看板布局类型' }));
    await user.click(screen.getByRole('option', { name: '无限画布' }));

    expect(mocks.setKanbanBoardStyle).toHaveBeenCalledWith('canvas');
  });

  it('floats the settings menu by default and applies the choice immediately', async () => {
    const user = userEvent.setup();
    render(<AppearanceSettings />);

    const toggle = screen.getByRole('switch', { name: '设置菜单悬浮' });
    expect(toggle).toBeChecked();
    expect(
      screen.getByText(
        '使用圆角悬浮组件显示设置菜单。关闭后左侧菜单直接平铺在背景上。'
      )
    ).toBeInTheDocument();

    await user.click(toggle);
    expect(mocks.setSettingsNavFloat).toHaveBeenCalledWith(false);
  });
});
