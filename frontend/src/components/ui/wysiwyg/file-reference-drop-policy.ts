import {
  FILE_REFERENCE_DRAG_MIME,
  parseFileReferencePayload,
  type FileReferencePayload,
} from '@/utils/fileReferences';

export function shouldAcceptFileReferenceDrag({
  disabled,
  dataTransferTypes,
  currentDraggedPayload,
}: {
  disabled: boolean;
  dataTransferTypes: Iterable<string>;
  currentDraggedPayload: FileReferencePayload | null;
}): boolean {
  if (disabled) return false;

  return (
    Array.from(dataTransferTypes).includes(FILE_REFERENCE_DRAG_MIME) ||
    Boolean(currentDraggedPayload)
  );
}

export function getFileReferenceDropPayload({
  disabled,
  serializedPayload,
  currentDraggedPayload,
}: {
  disabled: boolean;
  serializedPayload: string | null | undefined;
  currentDraggedPayload: FileReferencePayload | null;
}): FileReferencePayload | null {
  if (disabled) return null;

  return parseFileReferencePayload(serializedPayload) ?? currentDraggedPayload;
}

export function getCustomFileReferenceDropPayload({
  disabled,
  payload,
}: {
  disabled: boolean;
  payload: FileReferencePayload | null | undefined;
}): FileReferencePayload | null {
  if (disabled) return null;

  return payload ?? null;
}
