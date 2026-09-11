import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const scope = vi.hoisted(() => ({
  allowPreviewAssetScope: vi.fn(),
  isPreviewAssetScopeGranted: vi.fn(),
}));

vi.mock('@/lib/previewAssetScope', () => scope);

import { HostHtmlPreview } from './HostHtmlPreview';

const PROPS = {
  filePath: '/workspace/docs/page.html',
  assetRoot: '/workspace/docs',
  displayPath: 'docs/page.html',
};

const EXPECTED_SRC = 'asset://localhost//workspace/docs/page.html';

describe('HostHtmlPreview', () => {
  beforeEach(() => {
    scope.allowPreviewAssetScope.mockReset().mockResolvedValue(undefined);
    scope.isPreviewAssetScopeGranted.mockReset().mockReturnValue(false);
  });

  it('grants the asset scope before the page is loaded', async () => {
    render(<HostHtmlPreview {...PROPS} />);

    // Loading the page before the grant would render it without its assets.
    expect(screen.queryByTitle('docs/page.html')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeVisible();
    expect(scope.allowPreviewAssetScope).toHaveBeenCalledWith([
      '/workspace/docs',
    ]);

    expect(await screen.findByTitle('docs/page.html')).toHaveAttribute(
      'src',
      EXPECTED_SRC
    );
  });

  it('runs the page without a same-origin claim on the app', async () => {
    render(<HostHtmlPreview {...PROPS} />);

    const frame = await screen.findByTitle('docs/page.html');
    const sandbox = frame.getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-scripts');
    // Without allow-same-origin the page keeps an opaque origin, so it cannot
    // reach the VibeX DOM or the Tauri bridge.
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('renders straight away when the directory is already granted', () => {
    scope.isPreviewAssetScopeGranted.mockReturnValue(true);

    render(<HostHtmlPreview {...PROPS} />);

    expect(screen.getByTitle('docs/page.html')).toHaveAttribute(
      'src',
      EXPECTED_SRC
    );
    expect(scope.allowPreviewAssetScope).not.toHaveBeenCalled();
  });

  it('still renders the document when the scope grant fails', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    scope.allowPreviewAssetScope.mockRejectedValue(
      new Error('ipc unavailable')
    );

    render(<HostHtmlPreview {...PROPS} />);

    // Only the page's external assets are lost, not the page itself.
    expect(await screen.findByTitle('docs/page.html')).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('loads the newly selected file after a switch', async () => {
    scope.isPreviewAssetScopeGranted.mockReturnValue(true);
    const { rerender } = render(<HostHtmlPreview {...PROPS} />);

    rerender(
      <HostHtmlPreview
        filePath="/workspace/docs/other.html"
        assetRoot="/workspace/docs"
        displayPath="docs/other.html"
      />
    );

    expect(screen.getByTitle('docs/other.html')).toHaveAttribute(
      'src',
      'asset://localhost//workspace/docs/other.html'
    );
  });
});
