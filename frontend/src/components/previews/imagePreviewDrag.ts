export const ANNOTATED_IMAGE_DROP_EVENT = 'vibex-annotated-image-drop';
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_MOVE_TOLERANCE = 8;

export type AnnotatedImageDragState = {
  isDragging: boolean;
  file: File | null;
  pointer: { x: number; y: number } | null;
};

let dragState: AnnotatedImageDragState = {
  isDragging: false,
  file: null,
  pointer: null,
};
const listeners = new Set<(state: AnnotatedImageDragState) => void>();

function emit() {
  for (const listener of listeners) {
    listener(dragState);
  }
}

export function shouldStartLongPressDrag(elapsedMs: number, distance: number) {
  return elapsedMs >= LONG_PRESS_MS && distance <= LONG_PRESS_MOVE_TOLERANCE;
}

export function shouldCancelLongPress(distance: number) {
  return distance > LONG_PRESS_MOVE_TOLERANCE;
}

export function setCurrentDraggedAnnotatedImage(file: File | null) {
  dragState = {
    ...dragState,
    file,
    isDragging: Boolean(file),
  };
  emit();
}

export function getCurrentDraggedAnnotatedImage(): File | null {
  return dragState.file;
}

export function getAnnotatedImageDragState(): AnnotatedImageDragState {
  return dragState;
}

export function updateAnnotatedImageDragPointer(
  pointer: { x: number; y: number } | null
) {
  dragState = {
    ...dragState,
    pointer,
  };
  emit();
}

export function clearCurrentDraggedAnnotatedImage() {
  dragState = {
    isDragging: false,
    file: null,
    pointer: null,
  };
  emit();
}

export function subscribeAnnotatedImageDrag(
  listener: (state: AnnotatedImageDragState) => void
) {
  listeners.add(listener);
  listener(dragState);
  return () => {
    listeners.delete(listener);
  };
}

export function dispatchAnnotatedImageDrop(
  clientX: number,
  clientY: number
): boolean {
  if (typeof document === 'undefined' || !dragState.file) {
    return false;
  }
  const element = document.elementFromPoint(clientX, clientY);
  if (!(element instanceof Element)) {
    return false;
  }
  const dropZone = element.closest('[data-file-reference-drop-zone]');
  if (!(dropZone instanceof HTMLElement)) {
    return false;
  }
  dropZone.dispatchEvent(
    new CustomEvent<File>(ANNOTATED_IMAGE_DROP_EVENT, {
      detail: dragState.file,
      bubbles: false,
    })
  );
  return true;
}
