import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from 'shared/types';

import { OnboardingProjects } from '@/components/onboarding/OnboardingProjects';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { BasicGuideOverlay } from './BasicGuideOverlay';
import { useBasicGuide } from './BasicGuideContext';
import { BasicGuideProvider } from './BasicGuideProvider';
import { BASIC_GUIDE_STORAGE_KEY, COMPLETED_GUIDE } from './basicGuideState';

const userSystemMock = vi.hoisted(() => ({
  loading: false,
  onboardingAcknowledged: false,
}));

const projectsApiMock = vi.hoisted(() => ({
  getAll: vi.fn(),
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    config: { onboarding_acknowledged: userSystemMock.onboardingAcknowledged },
    loading: userSystemMock.loading,
  }),
}));

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  fileSystemApi: { list: vi.fn() },
  projectsApi: {
    getAll: projectsApiMock.getAll,
    create: vi.fn(),
    previewImport: vi.fn(),
  },
}));

vi.mock('@/lib/hostFs', () => ({
  pickHostDirectories: vi.fn(),
}));

function makeHomeProject(): Project {
  return {
    id: 'home',
    name: 'Global',
    root_path: 'C:/Users/demo',
    parent_project_id: null,
    hidden: false,
    is_home: true,
    is_git: false,
    default_agent_working_dir: null,
    default_main_branch: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

function mockElementRect(
  element: Element | null,
  rect: { left: number; top: number; width: number; height: number }
) {
  if (!element) return;
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    toJSON: () => ({}),
  } as DOMRect);
}

function GuideHarness({ showProjects = true }: { showProjects?: boolean }) {
  const guide = useBasicGuide();
  return (
    <>
      <div data-testid="guide-phase">{guide.state.phase}</div>
      <div data-testid="guide-substep">{guide.state.substep}</div>
      <div data-testid="guide-end-copy">{guide.state.endCopy}</div>
      <button type="button" onClick={() => guide.skip()}>
        trigger-skip
      </button>
      <button type="button" onClick={() => guide.start(true)}>
        trigger-enter-project
      </button>
      <button type="button" onClick={() => guide.continueStep()}>
        trigger-continue
      </button>
      <button type="button" onClick={() => guide.finish()}>
        trigger-finish
      </button>
      {showProjects ? (
        <OnboardingProjects
          active
          onBack={vi.fn()}
          onFinish={vi.fn().mockResolvedValue(undefined)}
        />
      ) : (
        <div
          data-basic-guide="toolbar-host-selector"
          data-testid="mock-host-selector"
        >
          Host
        </div>
      )}
    </>
  );
}

describe('BasicGuideProvider integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    userSystemMock.loading = false;
    userSystemMock.onboardingAcknowledged = false;
    projectsApiMock.getAll.mockResolvedValue([makeHomeProject()]);
    act(() => {
      useLayoutStore.getState().setActiveTab('kanban');
    });
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('reconciles stale completed state and StorageEvent updates so Step 5 still shows guide spotlights and transitions through main-window steps', async () => {
    window.localStorage.setItem(
      BASIC_GUIDE_STORAGE_KEY,
      JSON.stringify(COMPLETED_GUIDE)
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { rerender } = render(
      <HotkeysProvider initiallyActiveScopes={['dialog']}>
        <MemoryRouter initialEntries={['/']}>
          <QueryClientProvider client={queryClient}>
            <BasicGuideProvider>
              <GuideHarness />
              <BasicGuideOverlay />
            </BasicGuideProvider>
          </QueryClientProvider>
        </MemoryRouter>
      </HotkeysProvider>
    );

    const openFolder = await screen.findByTestId('zero-project-open-folder');
    const createProject = screen.getByTestId('zero-project-create-project');
    const enterGlobal = screen.getByTestId('zero-project-enter-global');

    mockElementRect(openFolder, {
      left: 400,
      top: 220,
      width: 320,
      height: 52,
    });
    mockElementRect(createProject, {
      left: 400,
      top: 280,
      width: 320,
      height: 52,
    });
    mockElementRect(enterGlobal, {
      left: 520,
      top: 430,
      width: 200,
      height: 28,
    });

    fireEvent(window, new Event('resize'));

    await waitFor(() => {
      expect(screen.getByTestId('guide-phase')).toHaveTextContent('active');
      expect(screen.getByTestId('guide-substep')).toHaveTextContent(
        'select-project'
      );
      expect(
        document.querySelector(
          '[data-basic-guide-callout="select-project-create"]'
        )
      ).toHaveTextContent('项目就是一个文件夹');
      expect(
        document.querySelector(
          '[data-basic-guide-callout="select-project-global"]'
        )
      ).toHaveTextContent('全局');
    });

    // Simulate syncFrontendPreferences asynchronously replaying a stale completed value.
    act(() => {
      const staleRaw = JSON.stringify(COMPLETED_GUIDE);
      window.localStorage.setItem(BASIC_GUIDE_STORAGE_KEY, staleRaw);
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: BASIC_GUIDE_STORAGE_KEY,
          newValue: staleRaw,
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('guide-phase')).toHaveTextContent('active');
      expect(
        document.querySelector(
          '[data-basic-guide-callout="select-project-create"]'
        )
      ).toBeInTheDocument();
    });

    // Selecting a project switches to the workspace tab and advances to toolbar-host-selector.
    userSystemMock.onboardingAcknowledged = true;
    fireEvent.click(
      screen.getByRole('button', { name: 'trigger-enter-project' })
    );
    rerender(
      <HotkeysProvider initiallyActiveScopes={['dialog']}>
        <MemoryRouter initialEntries={['/local-projects/home/sessions']}>
          <QueryClientProvider client={queryClient}>
            <BasicGuideProvider>
              <GuideHarness showProjects={false} />
              <BasicGuideOverlay />
            </BasicGuideProvider>
          </QueryClientProvider>
        </MemoryRouter>
      </HotkeysProvider>
    );

    mockElementRect(screen.getByTestId('mock-host-selector'), {
      left: 60,
      top: 12,
      width: 140,
      height: 28,
    });
    fireEvent(window, new Event('resize'));

    await waitFor(() => {
      expect(screen.getByTestId('guide-substep')).toHaveTextContent(
        'toolbar-host-selector'
      );
      expect(useLayoutStore.getState().activeTab).toBe('workspace');
      expect(
        document.querySelector(
          '[data-basic-guide-spotlight="toolbar-host-selector"]'
        )
      ).toBeInTheDocument();
      expect(
        document.querySelector(
          '[data-basic-guide-callout="toolbar-host-selector"]'
        )
      ).toBeInTheDocument();
    });

    for (const nextSubstep of [
      'project-switcher',
      'rail-session-list',
      'rail-bots',
      'rail-file-tree',
      'rail-git',
    ]) {
      fireEvent.click(screen.getByRole('button', { name: 'trigger-continue' }));
      await waitFor(() => {
        expect(screen.getByTestId('guide-substep')).toHaveTextContent(
          nextSubstep
        );
      });
    }

    fireEvent.click(screen.getByRole('button', { name: 'trigger-continue' }));
    await waitFor(() => {
      expect(screen.getByTestId('guide-phase')).toHaveTextContent('completed');
      expect(screen.getByTestId('guide-end-copy')).toHaveTextContent(
        'finished'
      );
      expect(
        document.querySelector('[data-basic-guide-callout="end"]')
      ).toHaveTextContent('更多使用技巧请查看官方文档或社区，Vibing~~~');
    });
  });

  it('preserves explicit skip during onboarding without reverting to idle', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <HotkeysProvider initiallyActiveScopes={['dialog']}>
        <MemoryRouter initialEntries={['/']}>
          <QueryClientProvider client={queryClient}>
            <BasicGuideProvider>
              <GuideHarness showProjects={false} />
            </BasicGuideProvider>
          </QueryClientProvider>
        </MemoryRouter>
      </HotkeysProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'trigger-skip' }));

    await waitFor(() => {
      expect(screen.getByTestId('guide-phase')).toHaveTextContent('completed');
    });
    expect(
      JSON.parse(window.localStorage.getItem(BASIC_GUIDE_STORAGE_KEY) ?? '{}')
        .phase
    ).toBe('completed');
  });
});
