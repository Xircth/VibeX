import type { FileReferencePayload } from './fileReferences';

export interface FileReferenceDragState {
  isDragging: boolean;
  payload: FileReferencePayload | null;
  pointer: { x: number; y: number } | null;
}

let dragState: FileReferenceDragState = {
  isDragging: false,
  payload: null,
  pointer: null,
};
const listeners = new Set<(state: FileReferenceDragState) => void>();

function emit() {
  for (const listener of listeners) {
    listener(dragState);
  }
}

export function setCurrentDraggedFileReference(
  payload: FileReferencePayload | null
) {
  dragState = {
    ...dragState,
    payload,
    isDragging: Boolean(payload),
  };
  emit();
}

export function getCurrentDraggedFileReference(): FileReferencePayload | null {
  return dragState.payload;
}

export function getFileReferenceDragState(): FileReferenceDragState {
  return dragState;
}

export function updateFileReferenceDragPointer(
  pointer: { x: number; y: number } | null
) {
  dragState = {
    ...dragState,
    pointer,
  };
  emit();
}

export function clearCurrentDraggedFileReference() {
  dragState = {
    isDragging: false,
    payload: null,
    pointer: null,
  };
  emit();
}

export function subscribeFileReferenceDrag(
  listener: (state: FileReferenceDragState) => void
) {
  listeners.add(listener);
  listener(dragState);
  return () => {
    listeners.delete(listener);
  };
}
