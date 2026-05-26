import { act, renderHook } from '@testing-library/react';
import {
  createRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useState,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import type { SessionComposerImage } from './SessionComposerInput';
import { useSessionComposerImageRemoval } from './useSessionComposerImageRemoval';

const profile = { executor: BaseCodingAgent.CODEX };

function renderImageRemovalHook({
  initialImages,
  draftMessage = 'draft',
  executorProfileRef = createRef() as MutableRefObject<typeof profile | null>,
}: {
  initialImages: SessionComposerImage[];
  draftMessage?: string;
  executorProfileRef?: MutableRefObject<typeof profile | null>;
}) {
  executorProfileRef.current = profile;
  const saveToScratch = vi.fn();

  const result = renderHook(() => {
    const [attachedImages, setAttachedImages] =
      useState<SessionComposerImage[]>(initialImages);
    const { handleRemoveImage } = useSessionComposerImageRemoval({
      draftMessage,
      executorProfileRef,
      saveToScratch,
      setAttachedImages:
        setAttachedImages as Dispatch<SetStateAction<SessionComposerImage[]>>,
    });

    return { attachedImages, handleRemoveImage };
  });

  return { ...result, saveToScratch, executorProfileRef };
}

describe('useSessionComposerImageRemoval', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('removes matching images, revokes previews, and persists remaining paths', () => {
    const keep = {
      id: 'keep',
      name: 'keep.png',
      path: 'vibe://keep',
    };
    const remove = {
      id: 'remove',
      name: 'remove.png',
      path: 'vibe://remove',
      previewUrl: 'blob:remove',
    };
    const { result, saveToScratch } = renderImageRemovalHook({
      initialImages: [keep, remove],
    });

    act(() => {
      result.current.handleRemoveImage('remove');
    });

    expect(result.current.attachedImages).toEqual([keep]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:remove');
    expect(saveToScratch).toHaveBeenCalledWith('draft', profile, [
      'vibe://keep',
    ]);
  });

  it('preserves no-match behavior while persisting the unchanged image paths', () => {
    const image = {
      id: 'keep',
      name: 'keep.png',
      path: 'vibe://keep',
      previewUrl: 'blob:keep',
    };
    const { result, saveToScratch } = renderImageRemovalHook({
      initialImages: [image],
    });

    act(() => {
      result.current.handleRemoveImage('missing');
    });

    expect(result.current.attachedImages).toEqual([image]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(saveToScratch).toHaveBeenCalledWith('draft', profile, [
      'vibe://keep',
    ]);
  });

  it('reads the current executor profile ref when removal happens', () => {
    const executorProfileRef =
      createRef() as MutableRefObject<typeof profile | null>;
    const { result, saveToScratch } = renderImageRemovalHook({
      initialImages: [
        {
          id: 'remove',
          name: 'remove.png',
          path: 'vibe://remove',
        },
      ],
      executorProfileRef,
    });
    executorProfileRef.current = null;

    act(() => {
      result.current.handleRemoveImage('remove');
    });

    expect(saveToScratch).toHaveBeenCalledWith('draft', null, []);
  });
});
