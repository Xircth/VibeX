import type { ComponentType } from 'react';
import NiceModal, { type NiceModalHocProps } from '@ebay/nice-modal-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, expect, it } from 'vitest';

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

  render(
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
  it('uses an Astryx multiline field for the project description', async () => {
    renderDialog();

    const descriptionInput = await screen.findByRole('textbox', {
      name: '项目简介（可选，用于 README）',
    });

    expect(descriptionInput.tagName).toBe('TEXTAREA');
    expect(descriptionInput.closest('.astryx-textarea')).not.toBeNull();
    expect(descriptionInput).toHaveAttribute('rows', '4');
  });

  it('uses Astryx fields and a compact location row', async () => {
    renderDialog();

    const nameInput = await screen.findByRole('textbox', {
      name: '项目名称',
    });
    const locationPreview = screen.getByRole('textbox', {
      name: '创建位置',
    });
    const locationButton = screen.getByRole('button', { name: '选择位置' });

    const nameField = nameInput.closest('.astryx-text-input');
    const locationField = locationPreview.closest('.astryx-text-input');

    expect(nameField).toHaveClass('[&_input]:text-sm');
    expect(nameField).toHaveStyle({
      backgroundColor: 'var(--surface-control)',
    });
    expect(locationField).toHaveAttribute('data-size', 'sm');
    expect(locationField).toHaveStyle({
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

  it('uses the same compact folder picker row for existing projects', async () => {
    renderDialog({ autoOpenFolderPicker: true });

    await screen.findByRole('heading', { name: '选择文件夹' });

    const folderPreview = screen.getByRole('textbox', {
      name: '项目文件夹',
    });
    const folderButton = screen.getByRole('button', { name: '选择文件夹' });
    const folderField = folderPreview.closest('.astryx-text-input');

    expect(folderField).toHaveAttribute('data-size', 'sm');
    expect(folderField).toHaveStyle({
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
});
