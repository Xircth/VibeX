import { act, render, renderHook } from '@testing-library/react';
import type { DragEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FILE_REFERENCE_DRAG_MIME,
  type FileReferencePayload,
  serializeFileReferencePayload,
} from '@/utils/fileReferences';
import {
  clearCurrentDraggedFileReference,
  getCurrentDraggedFileReference,
  setCurrentDraggedFileReference,
} from '@/utils/fileReferenceDrag';
import { useFileReferenceDropHandlers } from './use-file-reference-drop-handlers';

const payload: FileReferencePayload = {
  fileName: 'README.md',
  relativePath: 'docs/README.md',
  kind: 'file',
};

function dragEvent({
  types = [],
  serializedPayload = '',
}: {
  types?: string[];
  serializedPayload?: string;
} = {}) {
  return {
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
    dataTransfer: {
      types,
      dropEffect: 'none',
      getData: vi.fn(() => serializedPayload),
    },
  } as unknown as DragEvent;
}

function DropZone({
  disabled = false,
  onInsert,
}: {
  disabled?: boolean;
  onInsert: (payload: FileReferencePayload | null) => void;
}) {
  const { fileReferenceDropZoneRef, handleDragOver, handleDrop } =
    useFileReferenceDropHandlers({
      disabled,
      onInsertFileReference: onInsert,
    });

  return (
    <div
      data-testid="drop-zone"
      ref={fileReferenceDropZoneRef}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    />
  );
}

describe('useFileReferenceDropHandlers', () => {
  afterEach(() => {
    clearCurrentDraggedFileReference();
  });

  it('accepts file-reference dragover and marks copy drop effect', () => {
    const { result } = renderHook(() =>
      useFileReferenceDropHandlers({
        disabled: false,
        onInsertFileReference: vi.fn(),
      })
    );
    const event = dragEvent({ types: [FILE_REFERENCE_DRAG_MIME] });

    act(() => {
      result.current.handleDragOver(event);
    });

    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.dataTransfer.dropEffect).toBe('copy');
  });

  it('does not accept dragover when disabled', () => {
    setCurrentDraggedFileReference(payload);
    const { result } = renderHook(() =>
      useFileReferenceDropHandlers({
        disabled: true,
        onInsertFileReference: vi.fn(),
      })
    );
    const event = dragEvent({ types: [FILE_REFERENCE_DRAG_MIME] });

    act(() => {
      result.current.handleDragOver(event);
    });

    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.dataTransfer.dropEffect).toBe('none');
  });

  it('inserts serialized drops and clears the current dragged payload', () => {
    const onInsert = vi.fn();
    const { result } = renderHook(() =>
      useFileReferenceDropHandlers({
        disabled: false,
        onInsertFileReference: onInsert,
      })
    );
    setCurrentDraggedFileReference({
      ...payload,
      relativePath: 'fallback.md',
    });
    const event = dragEvent({
      serializedPayload: serializeFileReferencePayload(payload),
    });

    act(() => {
      result.current.handleDrop(event);
    });

    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onInsert).toHaveBeenCalledWith(payload);
    expect(getCurrentDraggedFileReference()).toBeNull();
  });

  it('inserts custom drop details and removes the listener on unmount', () => {
    const onInsert = vi.fn();
    const { getByTestId, unmount } = render(<DropZone onInsert={onInsert} />);
    const dropZone = getByTestId('drop-zone');
    setCurrentDraggedFileReference(payload);

    act(() => {
      dropZone.dispatchEvent(
        new CustomEvent('vibe-file-reference-drop', {
          detail: payload,
          bubbles: true,
        })
      );
    });

    expect(onInsert).toHaveBeenCalledWith(payload);
    expect(getCurrentDraggedFileReference()).toBeNull();

    unmount();
    act(() => {
      dropZone.dispatchEvent(
        new CustomEvent('vibe-file-reference-drop', {
          detail: payload,
          bubbles: true,
        })
      );
    });

    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it('ignores disabled drop and custom drop paths', () => {
    const onInsert = vi.fn();
    const { result } = renderHook(() =>
      useFileReferenceDropHandlers({
        disabled: true,
        onInsertFileReference: onInsert,
      })
    );
    const event = dragEvent({
      serializedPayload: serializeFileReferencePayload(payload),
    });

    act(() => {
      result.current.handleDrop(event);
    });

    const { getByTestId } = render(<DropZone disabled onInsert={onInsert} />);
    act(() => {
      getByTestId('drop-zone').dispatchEvent(
        new CustomEvent('vibe-file-reference-drop', {
          detail: payload,
          bubbles: true,
        })
      );
    });

    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onInsert).not.toHaveBeenCalled();
  });
});
