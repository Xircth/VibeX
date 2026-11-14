import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from 'shared/types';
import i18n from '@/i18n';
import { OnboardingProjects } from './OnboardingProjects';

const api = vi.hoisted(() => ({
  getAll: vi.fn(),
  create: vi.fn(),
  openProject: vi.fn(),
  clone: vi.fn(),
}));
vi.mock('@/lib/api/projects', () => ({ projectsApi: api }));
vi.mock('@/components/dialogs/projects/ProjectFormDialog', () => ({
  ProjectFormDialog: { show: api.openProject },
}));
vi.mock('@/components/dialogs/projects/CloneRepoDialog', () => ({
  CloneRepoDialog: { show: api.clone },
}));
const t = (key: string, values?: Record<string, unknown>) =>
  i18n.t(`dialogs:onboarding.${key}`, values) as string;
function project(id: string, home = false): Project {
  return {
    id,
    name: id,
    root_path: `C:/Work/${id}`,
    parent_project_id: null,
    hidden: false,
    is_home: home,
    is_git: false,
    default_agent_working_dir: null,
    default_main_branch: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}
const home = project('home', true);
const work = project('work');
function setup(
  initialProjectIds: string[] = [],
  onFinish = vi.fn().mockResolvedValue(undefined)
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <OnboardingProjects
          initialProjectIds={initialProjectIds}
          onBack={vi.fn()}
          onFinish={onFinish}
        />
      </QueryClientProvider>
    </StrictMode>
  );
  return onFinish;
}
describe('onboarding projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getAll.mockResolvedValue([home, work]);
  });
  it('selects existing projects by default and allows deselecting one', async () => {
    const finish = setup();
    expect(
      await screen.findByRole('checkbox', {
        name: i18n.t('app:welcomePage.globalProject'),
      })
    ).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: 'work' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'work' }));
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    await waitFor(() => expect(finish).toHaveBeenCalledWith(['home']));
  });
  it('selects imported projects and marks where they came from', async () => {
    const finish = setup(['work']);
    expect(await screen.findByText(t('importedProjectBadge'))).toBeVisible();
    expect(
      screen.getByText(t('importedProjectsReceipt', { count: 1 }))
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    await waitFor(() => expect(finish).toHaveBeenCalledWith(['home', 'work']));
  });
  it('keeps a deselected project deselected after the list reloads', async () => {
    setup();
    await screen.findByRole('checkbox', { name: 'work' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'work' }));
    api.getAll.mockResolvedValue([home, work, project('late')]);
    api.openProject.mockResolvedValue({ status: 'canceled' });
    fireEvent.click(
      screen.getByRole('button', { name: t('projectAction.open') })
    );
    await waitFor(() => expect(api.openProject).toHaveBeenCalled());
    expect(screen.getByRole('checkbox', { name: 'work' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });
  it('selects newly created projects and cloned repositories', async () => {
    api.openProject.mockResolvedValue({
      status: 'saved',
      project: project('new-project'),
    });
    api.clone.mockResolvedValue({
      status: 'cloned',
      repo: { name: 'clone', display_name: 'clone', path: 'C:/Work/clone' },
    });
    api.create.mockResolvedValue(project('clone'));
    const finish = setup();
    await screen.findByRole('checkbox', { name: 'work' });
    fireEvent.click(
      screen.getByRole('button', { name: t('projectAction.new') })
    );
    expect(
      await screen.findByRole('checkbox', { name: 'new-project' })
    ).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(
      screen.getByRole('button', { name: t('projectAction.clone') })
    );
    expect(
      await screen.findByRole('checkbox', { name: 'clone' })
    ).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    await waitFor(() =>
      expect(finish).toHaveBeenCalledWith([
        'home',
        'work',
        'new-project',
        'clone',
      ])
    );
  });
  it('keeps project selection open when final persistence fails', async () => {
    setup([], vi.fn().mockRejectedValue(new Error('Disk full')));
    fireEvent.click(await screen.findByRole('button', { name: t('next') }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full');
    expect(screen.getByRole('button', { name: t('next') })).toBeEnabled();
  });
});
