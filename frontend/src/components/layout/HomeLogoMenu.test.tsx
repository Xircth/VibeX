import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
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
  it('opens the same window and project actions as the main toolbar', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeLogoMenu align="start" />
      </MemoryRouter>
    );

    await user.click(
      screen.getByRole('button', { name: '返回首页或打开最近项目' })
    );

    expect(
      await screen.findByRole('menuitem', { name: '新建应用窗口' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: '回到首页' })
    ).toBeInTheDocument();
    expect(screen.getByText('最近项目')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'VibeX' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Notes' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Projects' })).toHaveAttribute(
      'href',
      '/local-projects'
    );

    await user.click(screen.getByRole('menuitem', { name: '新建应用窗口' }));
    expect(openLocalAppWindow).toHaveBeenCalledOnce();
  });
});
