import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { ArtifactTimelineCard } from './ArtifactTimelineCard';

describe('ArtifactTimelineCard', () => {
  it('opens and closes the recorded Artifact through its provider lease', async () => {
    const user = userEvent.setup();
    const call = vi.fn(async (command: string) => {
      if (command === 'artifact_open_preview') {
        return {
          leaseId: 'lease-1',
          artifactId: 'artifact-1',
          providerId: 'officecli',
          loopbackPort: 43123,
          capabilityToken: 'capability-1',
          expiresAtUnixMs: Date.now() + 60_000,
          previewUrl:
            'http://127.0.0.1:42100/api/v1/previews/lease-1/c/capability-1/',
          docxFallbackSupported: true,
        };
      }
      if (command === 'artifact_close_preview') return undefined;
      throw new Error(`unexpected command: ${command}`);
    });
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    render(
      <ArtifactTimelineCard
        transport={transport}
        artifact={{
          artifact_id: 'artifact-1',
          workspace_id: 'workspace-1',
          relative_path: 'deliverables/Q3-plan.pptx',
          media_type:
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          content_hash: 'sha256-a',
          revision: 1n,
          plugin_id: 'vibex.office',
          plugin_version: '2.0.0',
          provider_id: 'officecli',
          tool_lock_id: 'officecli@1.0.140',
        }}
      />
    );

    expect(screen.getByText('Q3-plan.pptx')).toBeVisible();
    expect(screen.getByText('PPTX · 修订 1')).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: '打开 Q3-plan.pptx 预览' })
    );

    expect(call).toHaveBeenCalledWith('artifact_open_preview', {
      artifactId: 'artifact-1',
    });
    expect(await screen.findByTitle('Q3-plan.pptx 预览')).toHaveAttribute(
      'src',
      'http://127.0.0.1:42100/api/v1/previews/lease-1/c/capability-1/'
    );
    expect(
      screen.getByRole('button', { name: '打开 Q3-plan.pptx 预览' })
    ).toBeDisabled();

    await user.click(
      screen.getByRole('button', { name: '关闭 Q3-plan.pptx 预览' })
    );
    expect(call).toHaveBeenCalledWith('artifact_close_preview', {
      leaseId: 'lease-1',
    });
  });

  it('closes a preview lease that arrives after the card unmounts', async () => {
    const user = userEvent.setup();
    let finishOpen:
      | ((lease: {
          leaseId: string;
          artifactId: string;
          providerId: string;
          loopbackPort: number;
          capabilityToken: string;
          expiresAtUnixMs: number;
          docxFallbackSupported: boolean;
        }) => void)
      | undefined;
    const pendingOpen = new Promise<{
      leaseId: string;
      artifactId: string;
      providerId: string;
      loopbackPort: number;
      capabilityToken: string;
      expiresAtUnixMs: number;
      docxFallbackSupported: boolean;
    }>((resolve) => {
      finishOpen = resolve;
    });
    const call = vi.fn(async (command: string) => {
      if (command === 'artifact_open_preview') return pendingOpen;
      if (command === 'artifact_close_preview') return undefined;
      throw new Error(`unexpected command: ${command}`);
    });
    const { unmount } = render(
      <ArtifactTimelineCard
        transport={{ environment: 'desktop', call }}
        artifact={{
          artifact_id: 'artifact-1',
          workspace_id: 'workspace-1',
          relative_path: 'deliverables/Q3-plan.pptx',
          media_type:
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          content_hash: 'sha256-a',
          revision: 1n,
          plugin_id: 'vibex.office',
          plugin_version: '2.0.0',
          provider_id: 'officecli',
          tool_lock_id: 'officecli@1.0.140',
        }}
      />
    );

    await user.click(
      screen.getByRole('button', { name: '打开 Q3-plan.pptx 预览' })
    );
    unmount();
    finishOpen?.({
      leaseId: 'late-lease',
      artifactId: 'artifact-1',
      providerId: 'officecli',
      loopbackPort: 43123,
      capabilityToken: 'capability-late',
      expiresAtUnixMs: Date.now() + 60_000,
      docxFallbackSupported: true,
    });

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('artifact_close_preview', {
        leaseId: 'late-lease',
      })
    );
  });

  it('uses a capability proxy in an opaque-origin iframe on Web', async () => {
    const user = userEvent.setup();
    const transport: BackendTransport = {
      environment: 'web',
      call: vi.fn(async (command: string) => {
        if (command === 'artifact_open_preview') {
          return {
            leaseId: 'lease-web',
            artifactId: 'artifact-1',
            providerId: 'officecli',
            loopbackPort: 43123,
            capabilityToken: 'capability-web',
            expiresAtUnixMs: Date.now() + 60_000,
            docxFallbackSupported: true,
          };
        }
        return undefined;
      }),
      artifactPreviewUrl: (lease) =>
        `https://server.example/api/v1/previews/${lease.leaseId}/c/${lease.capabilityToken}/`,
    };
    render(
      <ArtifactTimelineCard
        transport={transport}
        artifact={{
          artifact_id: 'artifact-1',
          workspace_id: 'workspace-1',
          relative_path: 'deliverables/Q3-plan.pptx',
          media_type:
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          content_hash: 'sha256-a',
          revision: 1n,
          plugin_id: 'vibex.office',
          plugin_version: '2.0.0',
          provider_id: 'officecli',
          tool_lock_id: 'officecli@1.0.140',
        }}
      />
    );

    await user.click(
      screen.getByRole('button', { name: '打开 Q3-plan.pptx 预览' })
    );
    const frame = await screen.findByTitle('Q3-plan.pptx 预览');
    expect(frame).toHaveAttribute(
      'src',
      'https://server.example/api/v1/previews/lease-web/c/capability-web/'
    );
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });
});
