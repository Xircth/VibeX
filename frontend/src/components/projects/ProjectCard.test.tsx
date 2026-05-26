import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import ProjectCard from './ProjectCard';

import type { Project } from 'shared/types';

const navigateMock = vi.fn();
const openInEditorMock = vi.fn();

vi.mock('@/hooks', () => ({
  useNavigateWithSearch: () => navigateMock,
  useProjectRepos: () => ({
    data: [{ id: 'repo-link-1', project_id: 'project-1', repo_id: 'repo-1' }],
  }),
}));

vi.mock('@/hooks/useOpenProjectInEditor', () => ({
  useOpenProjectInEditor: () => openInEditorMock,
}));

vi.mock('@/lib/api', () => ({
  projectsApi: {
    delete: vi.fn(),
  },
}));

const project: Project = {
  id: 'project-1',
  name: 'VibeX',
  default_agent_working_dir: null,
  default_main_branch: null,
  created_at: new Date('2026-05-26T00:00:00Z'),
  updated_at: new Date('2026-05-26T00:00:00Z'),
};

describe('ProjectCard', () => {
  it('renders readable project menu labels and creation metadata', async () => {
    const user = userEvent.setup();

    render(
      <ProjectCard
        project={project}
        isFocused={false}
        setError={vi.fn()}
        onEdit={vi.fn()}
      />
    );

    expect(screen.getByText(/创建于/)).toBeInTheDocument();

    await user.click(screen.getByRole('button'));

    expect(await screen.findByText('查看详情')).toBeInTheDocument();
    expect(screen.getByText('在 IDE 中打开')).toBeInTheDocument();
    expect(screen.getByText('编辑')).toBeInTheDocument();
    expect(screen.getByText('删除')).toBeInTheDocument();
  });
});
