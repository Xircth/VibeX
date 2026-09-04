import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { openFilePreview, closeFilePreview, renewFilePreview } = vi.hoisted(
  () => ({
    openFilePreview: vi.fn(),
    closeFilePreview: vi.fn(),
    renewFilePreview: vi.fn(),
  })
);

vi.mock('@/lib/api/plugins', () => ({
  pluginControlApi: { openFilePreview, closeFilePreview, renewFilePreview },
}));

vi.mock('@/lib/backendTransport', () => ({
  configuredBackendTransport: {
    artifactPreviewUrl: ({
      leaseId,
      capabilityToken,
    }: Record<string, string>) =>
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

  it('keeps the preview alive with a renew heartbeat and surfaces expiry', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    openFilePreview.mockResolvedValue({
      pluginId: 'vibex.office',
      providerId: 'officecli',
      generation: 8,
      leaseId: 'lease-8',
      capabilityToken: 'secret-capability',
      expiresAtUnixMs: Date.now() + 60_000,
      port: 43121,
      errorCode: null,
      errorMessage: null,
    });
    renewFilePreview
      .mockResolvedValueOnce({
        leaseId: 'lease-8',
        expiresAtUnixMs: Date.now() + 60_000,
      })
      .mockRejectedValueOnce(new Error('Preview lease is not active'));

    render(<PluginFilePreview filePath="/workspace/spec.docx" />);
    await screen.findByTitle('vibex.office preview');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(renewFilePreview).toHaveBeenCalledWith('lease-8');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(
      await screen.findByText('Preview lease is not active')
    ).toBeVisible();
    vi.useRealTimers();
  });
});
