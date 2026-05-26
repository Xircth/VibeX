import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { type Dispatch, type ReactNode, type SetStateAction, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent, type QueueStatus } from 'shared/types';
import type { SessionComposerImage } from './SessionComposerInput';
import { getQueueStatusQueryKey } from './sessionComposerQueue';
import { useSessionComposerImageUpload } from './useSessionComposerImageUpload';

const { uploadForAttemptMock } = vi.hoisted(() => ({
  uploadForAttemptMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  imagesApi: {
    uploadForAttempt: uploadForAttemptMock,
  },
}));

const profile = { executor: BaseCodingAgent.CODEX };

function queuedStatus(): Extract<QueueStatus, { status: 'queued' }> {
  return {
    status: 'queued',
    message: {
      session_id: 'session-1',
      queued_at: '2026-05-25T00:00:00.000Z',
      data: {
        message: 'queued draft',
        images: ['.vibe-images/queued.png', '.vibe-images/shared.png'],
        executor_config: profile,
        queued: true,
      },
    },
  };
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function renderImageUploadHook({
  queryClient,
  initialImages = [],
  workspaceId = 'workspace-1',
}: {
  queryClient: QueryClient;
  initialImages?: SessionComposerImage[];
  workspaceId?: string;
}) {
  const saveToScratch = vi.fn();
  const applyDraftMessage = vi.fn();
  const cancelQueue = vi.fn();

  const result = renderHook(
    () => {
      const [attachedImages, setAttachedImages] =
        useState<SessionComposerImage[]>(initialImages);
      const { handleAttachImages } = useSessionComposerImageUpload({
        workspaceId,
        sessionId: 'session-1',
        draftMessage: 'local draft',
        executorProfile: profile,
        saveToScratch,
        applyDraftMessage,
        cancelQueue,
        setAttachedImages:
          setAttachedImages as Dispatch<SetStateAction<SessionComposerImage[]>>,
      });

      return { attachedImages, handleAttachImages };
    },
    { wrapper: wrapperFor(queryClient) }
  );

  return { ...result, saveToScratch, applyDraftMessage, cancelQueue };
}

describe('useSessionComposerImageUpload', () => {
  beforeEach(() => {
    uploadForAttemptMock.mockReset();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:new-preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('suppresses uploads without a workspace id', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderImageUploadHook({
      queryClient,
      workspaceId: '',
    });

    await act(async () => {
      await result.current.handleAttachImages([new File(['a'], 'a.png')]);
    });

    expect(uploadForAttemptMock).not.toHaveBeenCalled();
  });

  it('applies uploaded images against queued composer state', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(getQueueStatusQueryKey('session-1'), queuedStatus());
    uploadForAttemptMock.mockResolvedValue({
      id: 'upload',
      original_name: 'shared.png',
      file_path: '.vibe-images/shared.png',
    });

    const replacedPreview = {
      id: 'current-shared',
      name: 'current-shared.png',
      path: '.vibe-images/shared.png',
      previewUrl: 'blob:old-preview',
    };
    const current = {
      id: 'current',
      name: 'current.png',
      path: '.vibe-images/current.png',
      previewUrl: 'blob:current-preview',
    };
    const {
      result,
      saveToScratch,
      applyDraftMessage,
      cancelQueue,
    } = renderImageUploadHook({
      queryClient,
      initialImages: [replacedPreview, current],
    });

    const file = new File(['new'], 'shared.png');
    await act(async () => {
      await result.current.handleAttachImages([file]);
    });

    expect(uploadForAttemptMock).toHaveBeenCalledWith('workspace-1', file);
    expect(cancelQueue).toHaveBeenCalledOnce();
    expect(applyDraftMessage).toHaveBeenCalledWith('queued draft');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-preview');
    expect(saveToScratch).toHaveBeenCalledWith('queued draft', profile, [
      '.vibe-images/queued.png',
      '.vibe-images/shared.png',
      '.vibe-images/current.png',
    ]);
    expect(result.current.attachedImages).toEqual([
      {
        id: '.vibe-images/queued.png',
        name: 'queued.png',
        path: '.vibe-images/queued.png',
      },
      {
        id: 'upload',
        name: 'shared.png',
        path: '.vibe-images/shared.png',
        previewUrl: 'blob:new-preview',
      },
      current,
    ]);
  });
});
