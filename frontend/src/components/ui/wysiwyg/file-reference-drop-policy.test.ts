import { describe, expect, it } from 'vitest';

import {
  FILE_REFERENCE_DRAG_MIME,
  type FileReferencePayload,
  serializeFileReferencePayload,
} from '@/utils/fileReferences';
import {
  getCustomFileReferenceDropPayload,
  getFileReferenceDropPayload,
  shouldAcceptFileReferenceDrag,
} from './file-reference-drop-policy';

const payload: FileReferencePayload = {
  fileName: 'README.md',
  relativePath: 'docs/README.md',
  kind: 'file',
};

describe('file reference drop policy', () => {
  it('rejects dragover and drop intake when disabled', () => {
    expect(
      shouldAcceptFileReferenceDrag({
        disabled: true,
        dataTransferTypes: [FILE_REFERENCE_DRAG_MIME],
        currentDraggedPayload: payload,
      })
    ).toBe(false);
    expect(
      getFileReferenceDropPayload({
        disabled: true,
        serializedPayload: serializeFileReferencePayload(payload),
        currentDraggedPayload: payload,
      })
    ).toBeNull();
    expect(
      getCustomFileReferenceDropPayload({
        disabled: true,
        payload,
      })
    ).toBeNull();
  });

  it('accepts dragover for the file-reference MIME type or app-managed drag payload', () => {
    expect(
      shouldAcceptFileReferenceDrag({
        disabled: false,
        dataTransferTypes: [FILE_REFERENCE_DRAG_MIME],
        currentDraggedPayload: null,
      })
    ).toBe(true);
    expect(
      shouldAcceptFileReferenceDrag({
        disabled: false,
        dataTransferTypes: [],
        currentDraggedPayload: payload,
      })
    ).toBe(true);
    expect(
      shouldAcceptFileReferenceDrag({
        disabled: false,
        dataTransferTypes: ['text/plain'],
        currentDraggedPayload: null,
      })
    ).toBe(false);
  });

  it('prefers valid serialized drop payloads over the current dragged payload', () => {
    const serializedPayload = serializeFileReferencePayload({
      ...payload,
      relativePath: 'src/App.tsx',
    });

    expect(
      getFileReferenceDropPayload({
        disabled: false,
        serializedPayload,
        currentDraggedPayload: payload,
      })
    ).toEqual({
      ...payload,
      relativePath: 'src/App.tsx',
    });
  });

  it('falls back to the current dragged payload when serialized payload is missing or invalid', () => {
    expect(
      getFileReferenceDropPayload({
        disabled: false,
        serializedPayload: '',
        currentDraggedPayload: payload,
      })
    ).toEqual(payload);
    expect(
      getFileReferenceDropPayload({
        disabled: false,
        serializedPayload: '{bad json',
        currentDraggedPayload: payload,
      })
    ).toEqual(payload);
  });

  it('ignores drops without a valid serialized or current payload', () => {
    expect(
      getFileReferenceDropPayload({
        disabled: false,
        serializedPayload: '',
        currentDraggedPayload: null,
      })
    ).toBeNull();
  });

  it('uses custom drop details only in editable mode', () => {
    expect(
      getCustomFileReferenceDropPayload({
        disabled: false,
        payload,
      })
    ).toEqual(payload);
    expect(
      getCustomFileReferenceDropPayload({
        disabled: false,
        payload: null,
      })
    ).toBeNull();
  });
});
