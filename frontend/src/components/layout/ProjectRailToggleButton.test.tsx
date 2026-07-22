import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectRail } from '@/components/layout/ProjectRail';
import { ProjectRailToggleButton } from '@/components/layout/ProjectRailToggleButton';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('liquid-glass-react', () => ({
  default: ({
    children,
    className,
  }: React.PropsWithChildren<{ className?: string }>) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({ projects: [], isLoading: false }),
}));

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => ({ projectId: 'project-1' }),
}));

vi.mock('@/hooks/useProjectSwitcher', () => ({
  useProjectSwitcher: () => vi.fn(),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

describe('ProjectRailToggleButton', () => {
  beforeEach(() => {
    useWindowProjectsStore.setState({ railVisible: false });
  });

  it('reveals the mounted project rail when clicked', () => {
    const { container } = render(
      <>
        <ProjectRailToggleButton />
        <ProjectRail />
      </>
    );

    expect(container.querySelector('.project-rail-inline-host')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'railToggle.show' }));

    expect(
      container.querySelector('.project-rail-inline-host')
    ).toBeInTheDocument();
  });
});
