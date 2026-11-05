import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentType } from 'react';
import NiceModal, { type NiceModalHocProps } from '@ebay/nice-modal-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { projectsApi, repoApi } from '@/lib/api';
import {
  ProjectFormDialog,
  type ProjectFormDialogProps,
} from './ProjectFormDialog';

const Dialog = ProjectFormDialog as ComponentType<
  ProjectFormDialogProps & NiceModalHocProps
>;

function renderDialog(props: ProjectFormDialogProps = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <HotkeysProvider initiallyActiveScopes={['dialog', 'kanban', 'projects']}>
        <NiceModal.Provider>
          <Dialog id="project-form-dialog-test" defaultVisible {...props} />
        </NiceModal.Provider>
      </HotkeysProvider>
    </QueryClientProvider>
  );
}

describe('ProjectFormDialog', () => {
  beforeEach(() => {
    vi.spyOn(repoApi, 'checkGitRepoPath').mockResolvedValue(false);
    vi.spyOn(projectsApi, 'previewImport').mockResolvedValue({
      path: '/Users/mac/Projects/workspace',
      is_git: false,
      children: [],
    });
  });

  it('creates new projects through the Host command, not the client filesystem', () => {
    const source = readFileSync(
      join(import.meta.dirname, 'ProjectFormDialog.tsx'),
      'utf8'
    );
    expect(source).not.toContain('writeTextFile');
    expect(source).not.toContain('@tauri-apps/plugin-fs');
    expect(source).toContain('parentPath');
    expect(source).toContain('folderName');
  });

  it('uses an Astryx multiline field for the project description', async () => {
    renderDialog();

    const descriptionInput = await screen.findByRole('textbox', {
      name: '项目简介（可选，用于 README）',
    });

    expect(descriptionInput.tagName).toBe('TEXTAREA');
    expect(descriptionInput.closest('.astryx-textarea')).toHaveClass(
      'project-form-description-field'
    );
    expect(descriptionInput).toHaveAttribute('rows', '4');
  });

  it('uses Astryx fields and a compact location row', async () => {
    const { container } = renderDialog();

    const nameInput = await screen.findByRole('textbox', {
      name: '项目名称',
    });
    const locationPreview = screen.getByRole('textbox', {
      name: '创建位置',
    });
    const locationButton = screen.getByRole('button', { name: '选择位置' });

    const nameField = nameInput.closest('.astryx-text-input');
    const locationField = locationPreview.closest('.astryx-text-input');
    const dialogSurface = container.querySelector('[role="dialog"]');

    expect(dialogSurface).toHaveClass('welcome-project-form-surface');
    expect(nameField).toHaveClass('[&_input]:text-sm');
    expect(nameField).not.toHaveStyle({
      backgroundColor: 'var(--surface-control)',
    });
    expect(locationField).toHaveAttribute('data-size', 'sm');
    expect(locationField).not.toHaveStyle({
      backgroundColor: 'var(--surface-control)',
    });
    expect(locationPreview).toHaveAttribute('readonly');
    expect(locationPreview).toHaveAttribute('aria-readonly', 'true');
    expect(locationButton).toHaveClass(
      'h-7',
      'text-xs',
      'bg-[var(--surface-control-hover)]'
    );
  });

  it('uses a dropped folder as the selected existing project folder', async () => {
    vi.mocked(repoApi.checkGitRepoPath).mockResolvedValue(true);

    renderDialog({
      autoOpenFolderPicker: true,
      initialFolderPath: '/Users/mac/Projects/app',
    });

    expect(
      await screen.findByDisplayValue('/Users/mac/Projects/app')
    ).toBeInTheDocument();
    expect(await screen.findByText('已识别为 Git 仓库')).toBeInTheDocument();
    expect(repoApi.checkGitRepoPath).toHaveBeenCalledWith(
      '/Users/mac/Projects/app'
    );
  });

  it('uses the same compact folder picker row for existing projects', async () => {
    const { container } = renderDialog({ autoOpenFolderPicker: true });

    await screen.findByRole('heading', { name: '选择文件夹' });

    const folderPreview = screen.getByRole('textbox', {
      name: '项目文件夹',
    });
    const folderButton = screen.getByRole('button', { name: '选择文件夹' });
    const folderField = folderPreview.closest('.astryx-text-input');
    const dialogSurface = container.querySelector('[role="dialog"]');

    expect(dialogSurface).toHaveClass('welcome-project-form-surface');
    expect(folderField).toHaveAttribute('data-size', 'sm');
    expect(folderField).not.toHaveStyle({
      backgroundColor: 'var(--surface-control)',
    });
    expect(folderPreview).toHaveAttribute('readonly');
    expect(folderPreview).toHaveAttribute('aria-readonly', 'true');
    expect(folderButton).toHaveClass(
      'h-7',
      'text-xs',
      'bg-[var(--surface-control-hover)]'
    );
  });

  it('selects and deselects all discovered git child repos, with a scrollable list', async () => {
    const user = userEvent.setup();
    vi.mocked(projectsApi.previewImport).mockResolvedValue({
      path: '/Users/mac/Projects/workspace',
      is_git: false,
      children: [
        {
          name: 'api',
          path: '/Users/mac/Projects/workspace/api',
          existing_project_id: null,
        },
        {
          name: 'web',
          path: '/Users/mac/Projects/workspace/web',
          existing_project_id: null,
        },
        {
          name: 'cli',
          path: '/Users/mac/Projects/workspace/cli',
          existing_project_id: null,
        },
      ],
    });

    renderDialog({
      autoOpenFolderPicker: true,
      initialFolderPath: '/Users/mac/Projects/workspace',
    });

    expect(await screen.findByText('发现 3 个 Git 仓库')).toBeInTheDocument();

    const list = screen.getByTestId('discovered-git-repos-list');
    expect(list).toHaveClass('overflow-y-auto', 'max-h-40');

    const checkboxes = within(list).getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(3);
    for (const checkbox of checkboxes) {
      expect(checkbox).not.toBeChecked();
    }

    await user.click(screen.getByRole('button', { name: '全选' }));
    for (const checkbox of within(list).getAllByRole('checkbox')) {
      expect(checkbox).toBeChecked();
    }

    await user.click(screen.getByRole('button', { name: '取消全选' }));
    for (const checkbox of within(list).getAllByRole('checkbox')) {
      expect(checkbox).not.toBeChecked();
    }
  });
});
