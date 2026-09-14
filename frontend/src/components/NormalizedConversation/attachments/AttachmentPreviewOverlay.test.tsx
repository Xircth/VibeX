import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import {
  AttachmentPreviewProvider,
  useOptionalAttachmentPreview,
  type AttachmentPreviewTarget,
} from './AttachmentPreviewOverlay';

vi.mock('@/hooks/useFileContent', () => ({
  useFileContent: () => ({
    data: '# Spec',
    isLoading: false,
    error: null,
  }),
  useBinaryAssetPreview: () => ({
    assetUrl: 'blob:application/pdf',
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/components/NormalizedConversation/AstryxMarkdown', () => ({
  AstryxMarkdown: ({ value }: { value: string }) => (
    <div data-testid="attachment-markdown">{value}</div>
  ),
}));

function OpenButton(props: AttachmentPreviewTarget) {
  const overlay = useOptionalAttachmentPreview();
  return (
    <button type="button" onClick={() => overlay?.open(props)}>
      open
    </button>
  );
}

function renderOverlayHost(target: AttachmentPreviewTarget) {
  return render(
    <div data-conversation-preview-host className="relative">
      <AttachmentPreviewProvider>
        <OpenButton {...target} />
      </AttachmentPreviewProvider>
    </div>
  );
}

describe('AttachmentPreviewOverlay', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('previews markdown inside the session overlay', () => {
    renderOverlayHost({
      fileName: 'notes.md',
      filePath: '/tmp/notes.md',
      previewKind: 'text',
    });

    fireEvent.click(screen.getByRole('button', { name: 'open' }));

    expect(
      screen.getByTestId('attachment-preview-overlay')
    ).toBeInTheDocument();
    expect(screen.getByTestId('attachment-markdown')).toHaveTextContent(
      '# Spec'
    );
  });

  it('previews pdf inside the session overlay', () => {
    renderOverlayHost({
      fileName: 'notes.pdf',
      filePath: '/tmp/notes.pdf',
      previewKind: 'pdf',
    });

    fireEvent.click(screen.getByRole('button', { name: 'open' }));

    expect(
      screen.getByTestId('attachment-preview-overlay')
    ).toBeInTheDocument();
    expect(document.querySelector('object')).toHaveAttribute(
      'data',
      'blob:application/pdf'
    );
  });

  it('tells the user when the board cannot preview a format', () => {
    renderOverlayHost({
      fileName: 'letter.docx',
      filePath: '/tmp/letter.docx',
      previewKind: 'binary',
    });

    fireEvent.click(screen.getByRole('button', { name: 'open' }));

    expect(
      screen.getByTestId('attachment-preview-unsupported')
    ).toHaveTextContent('当前格式不支持在看板中预览');
  });

  it('closes on Escape', () => {
    renderOverlayHost({
      fileName: 'letter.docx',
      filePath: '/tmp/letter.docx',
      previewKind: 'binary',
    });

    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(
      screen.getByTestId('attachment-preview-overlay')
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(
      screen.queryByTestId('attachment-preview-overlay')
    ).not.toBeInTheDocument();
  });
});
