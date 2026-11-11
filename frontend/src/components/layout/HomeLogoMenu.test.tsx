import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { HomeLogoMenu } from './HomeLogoMenu';

const openLocalAppWindow = vi.hoisted(() => vi.fn());
const switchProject = vi.hoisted(() => vi.fn());
const useTauriClient = vi.hoisted(() => vi.fn(() => true));

vi.mock('@/lib/api/appWindow', () => ({
  openLocalAppWindow,
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    projects: [
      { id: 'p1', name: 'VibeX' },
      { id: 'p2', name: 'Notes' },
    ],
  }),
}));

vi.mock('@/hooks/useProjectSwitcher', () => ({
  useProjectSwitcher: () => switchProject,
}));

vi.mock('@/lib/desktopShell', () => ({
  useTauriClient,
}));

describe('HomeLogoMenu', () => {
  beforeEach(() => {
    openLocalAppWindow.mockReset();
    switchProject.mockReset();
    useWindowProjectsStore.getState().resetProjectWindowState();
  });

  it('exposes window creation, quick project switcher trigger, and recent projects without standalone homepage links', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeLogoMenu align="start" />
      </MemoryRouter>
    );

    const logo = screen.getByRole('button', {
      name: /项目|project/i,
    });
    expect(logo).toHaveClass('home-logo-button');
    expect(logo).not.toHaveClass('workspace-toolbar-button');

    await user.click(logo);

    expect(
      await screen.findByRole('menuitem', { name: '新建应用窗口' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: '切换项目…' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: '回到首页' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Projects' })
    ).not.toBeInTheDocument();
    expect(screen.getByText('已导入项目')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'VibeX' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Notes' })).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: '切换项目…' }));
    expect(useWindowProjectsStore.getState().railVisible).toBe(true);

    await user.click(logo);
    await user.click(
      await screen.findByRole('menuitem', { name: '新建应用窗口' })
    );
    expect(openLocalAppWindow).toHaveBeenCalledOnce();
  });
});
