import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from 'shared/types';
import i18n from '@/i18n';
import { OnboardingProjects } from './OnboardingProjects';

const api = vi.hoisted(() => ({
  getAll: vi.fn(),
  create: vi.fn(),
  previewImport: vi.fn(),
  openProject: vi.fn(),
  clone: vi.fn(),
  pickDirectories: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  fileSystemApi: { list: vi.fn() },
  projectsApi: {
    getAll: api.getAll,
    create: api.create,
    previewImport: api.previewImport,
  },
}));
vi.mock('@/lib/hostFs', () => ({
  pickHostDirectories: api.pickDirectories,
}));
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
  onFinish = vi.fn().mockResolvedValue(undefined),
  onBack = vi.fn(),
  onNavigateStep = vi.fn()
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <OnboardingProjects
          initialProjectIds={initialProjectIds}
          onBack={onBack}
          onNavigateStep={onNavigateStep}
          onFinish={onFinish}
        />
      </QueryClientProvider>
    </StrictMode>
  );
  return { onFinish, onBack, onNavigateStep };
}

describe('onboarding projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getAll.mockResolvedValue([home]);
    api.previewImport.mockResolvedValue({ is_git: false, children: [] });
  });

  it('shows the zero-project stage when only Global exists and enters Global directly', async () => {
    const { onFinish } = setup();
    expect(
      await screen.findByTestId('zero-project-open-folder')
    ).toBeInTheDocument();
    expect(screen.getByTestId('zero-project-create-project')).toBeInTheDocument();
    expect(screen.getByTestId('zero-project-clone-repo')).toBeInTheDocument();
    expect(
      screen.queryByTestId('onboarding-project-list-spotlight')
    ).toBeNull();

    fireEvent.click(screen.getByTestId('zero-project-enter-global'));
    await waitFor(() => expect(onFinish).toHaveBeenCalledWith(['home']));
  });

  it('batch-imports multiple selected folders and switches to the two-column guided list', async () => {
    api.pickDirectories.mockResolvedValue(['C:/Work/alpha', 'C:/Work/beta']);
    api.previewImport
      .mockResolvedValueOnce({ is_git: true, children: [] })
      .mockResolvedValueOnce({ is_git: false, children: [] });
    api.create
      .mockResolvedValueOnce(project('alpha'))
      .mockResolvedValueOnce(project('beta'));

    const { onFinish } = setup();
    fireEvent.click(await screen.findByTestId('zero-project-open-folder'));

    const spotlight = await screen.findByTestId(
      'onboarding-project-list-spotlight'
    );
    expect(screen.getByTestId('onboarding-projects-split')).toBeInTheDocument();
    expect(
      screen.getByText(t('selectProjectToEnterGuide'))
    ).toBeInTheDocument();
    expect(
      screen.getByText(t('projectsMultiImported', { count: 2 }))
    ).toBeInTheDocument();
    expect(
      within(spotlight).getByTestId('onboarding-project-item-home')
    ).toBeInTheDocument();
    expect(
      within(spotlight).getByTestId('onboarding-project-item-alpha')
    ).toBeInTheDocument();
    expect(
      within(spotlight).getByTestId('onboarding-project-item-beta')
    ).toBeInTheDocument();

    expect(api.create).toHaveBeenNthCalledWith(1, {
      name: 'alpha',
      rootPath: 'C:/Work/alpha',
      repositories: [
        { display_name: 'alpha', git_repo_path: 'C:/Work/alpha' },
      ],
    });
    expect(api.create).toHaveBeenNthCalledWith(2, {
      name: 'beta',
      rootPath: 'C:/Work/beta',
      repositories: [],
    });

    fireEvent.click(
      within(spotlight).getByTestId('onboarding-project-item-beta')
    );
    await waitFor(() =>
      expect(onFinish).toHaveBeenCalledWith(['beta', 'home', 'alpha'])
    );
  });

  it('adds newly created and cloned projects to the list and enters the clicked project', async () => {
    api.openProject.mockResolvedValue({
      status: 'saved',
      project: project('new-project'),
    });
    api.clone.mockResolvedValue({
      status: 'cloned',
      repo: { name: 'clone', display_name: 'clone', path: 'C:/Work/clone' },
    });
    api.create.mockResolvedValue(project('clone'));

    const { onFinish } = setup();
    fireEvent.click(await screen.findByTestId('zero-project-create-project'));
    expect(
      await screen.findByTestId('onboarding-project-item-new-project')
    ).toBeInTheDocument();
    expect(onFinish).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('zero-project-clone-repo'));
    expect(
      await screen.findByTestId('onboarding-project-item-clone')
    ).toBeInTheDocument();
    expect(onFinish).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('onboarding-project-item-home'));
    await waitFor(() =>
      expect(onFinish).toHaveBeenCalledWith(['home', 'new-project', 'clone'])
    );
  });

  it('keeps project selection open when final persistence fails', async () => {
    api.getAll.mockResolvedValue([home, work]);
    setup([], vi.fn().mockRejectedValue(new Error('Disk full')));
    fireEvent.click(
      await screen.findByTestId('onboarding-project-item-work')
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full');
    expect(screen.getByTestId('onboarding-project-item-work')).toBeEnabled();
  });

  it('refreshes and highlights imported projects when becoming active after mount', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const onFinish = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <OnboardingProjects
            initialProjectIds={[]}
            active={false}
            onBack={vi.fn()}
            onFinish={onFinish}
          />
        </QueryClientProvider>
      </StrictMode>
    );
    expect(api.getAll).not.toHaveBeenCalled();

    const imported = project('imported-1');
    api.getAll.mockResolvedValue([home, work, imported]);
    rerender(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <OnboardingProjects
            initialProjectIds={['imported-1']}
            active
            onBack={vi.fn()}
            onFinish={onFinish}
          />
        </QueryClientProvider>
      </StrictMode>
    );

    const row = await screen.findByTestId('onboarding-project-item-imported-1');
    expect(within(row).getByText(t('importedProjectBadge'))).toBeVisible();

    fireEvent.click(row);
    await waitFor(() =>
      expect(onFinish).toHaveBeenCalledWith(['imported-1', 'home', 'work'])
    );
  });

  it('supports 5/5 breadcrumb navigation back to prior onboarding steps', async () => {
    const { onBack, onNavigateStep } = setup();
    expect(await screen.findByText('5 / 5')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: t('appearanceStep') }));
    expect(onNavigateStep).toHaveBeenCalledWith('appearance');

    fireEvent.click(screen.getByRole('button', { name: t('back') }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
