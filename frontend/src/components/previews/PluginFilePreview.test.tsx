import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { openFilePreview, closeFilePreview } = vi.hoisted(() => ({
  openFilePreview: vi.fn(),
  closeFilePreview: vi.fn(),
}));

vi.mock('@/lib/api/plugins', () => ({
  pluginControlApi: { openFilePreview, closeFilePreview },
}));

vi.mock('@/lib/backendTransport', () => ({
  configuredBackendTransport: {
    artifactPreviewUrl: ({ leaseId, capabilityToken }: Record<string, string>) =>
      `https://host.test/api/v1/previews/${leaseId}/c/${capabilityToken}/`,
  },
}));

import { PluginFilePreview } from './PluginFilePreview';

afterEach(() => {
  vi.clearAllMocks();
});

describe('PluginFilePreview', () => {
  it('renders the resolved generation lease through the transport capability URL', async () => {
    openFilePreview.mockResolvedValue({
      pluginId: 'vibex.office',
      providerId: 'officecli',
      generation: 8,
      leaseId: 'lease-8',
      capabilityToken: 'secret-capability',
      expiresAtUnixMs: 1000,
      port: 43121,
      errorCode: null,
      errorMessage: null,
    });
    const view = render(<PluginFilePreview filePath="/workspace/spec.docx" />);
    const frame = await screen.findByTitle('vibex.office preview');
    expect(frame).toHaveAttribute(
      'src',
      'https://host.test/api/v1/previews/lease-8/c/secret-capability/'
    );
    view.unmount();
    await waitFor(() => {
      expect(closeFilePreview).toHaveBeenCalledWith(
        '/workspace/spec.docx',
        'lease-8'
      );
    });
  });

  it('contains provider failure without taking down the preview panel', async () => {
    openFilePreview.mockResolvedValue({
      pluginId: 'vibex.office',
      providerId: 'officecli',
      generation: 8,
      leaseId: null,
      capabilityToken: null,
      expiresAtUnixMs: null,
      port: null,
      errorCode: 'NOT_INSTALLED',
      errorMessage: 'The plugin Runtime is not installed.',
    });
    render(<PluginFilePreview filePath="/workspace/spec.docx" />);
    expect(
      await screen.findByText('The plugin Runtime is not installed.')
    ).toBeVisible();
  });
});
