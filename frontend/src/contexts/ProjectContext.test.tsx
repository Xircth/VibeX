import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SerializedDockview } from 'dockview';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectProvider } from '@/contexts/ProjectContext';
import { useLayoutStore } from '@/stores/useLayoutStore';

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    projects: [],
    projectsById: {},
    isLoading: false,
    isConnected: true,
    error: null,
  }),
}));

interface LayoutObservation {
  projectKey: string;
  hasSerializedLayout: boolean;
}

function LayoutScopeProbe({
  observations,
}: {
  observations: LayoutObservation[];
}) {
  const projectKey = useLayoutStore((state) => state.currentProjectKey);
  const serializedLayout = useLayoutStore((state) => state.serializedLayout);

  observations.push({
    projectKey,
    hasSerializedLayout: serializedLayout !== null,
  });

  return <div data-testid="layout-project-key">{projectKey}</div>;
}

describe('ProjectProvider layout scope', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useLayoutStore.getState().setCurrentProject('previous-project');
    useLayoutStore.getState().resetLayout();
    useLayoutStore.getState().setSerializedLayout({} as SerializedDockview);
  });

  it('does not mount project children with the previous project layout', async () => {
    const observations: LayoutObservation[] = [];

    render(
      <MemoryRouter initialEntries={['/local-projects/new-project/sessions']}>
        <ProjectProvider>
          <LayoutScopeProbe observations={observations} />
        </ProjectProvider>
      </MemoryRouter>
    );

    expect(await screen.findByTestId('layout-project-key')).toHaveTextContent(
      'new-project'
    );
    expect(observations).toEqual([
      {
        projectKey: 'new-project',
        hasSerializedLayout: false,
      },
    ]);
  });
});
