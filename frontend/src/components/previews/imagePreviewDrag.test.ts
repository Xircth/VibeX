import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCurrentDraggedAnnotatedImage,
  dispatchAnnotatedImageDrop,
  getCurrentDraggedAnnotatedImage,
  setCurrentDraggedAnnotatedImage,
  shouldCancelLongPress,
  shouldStartLongPressDrag,
} from './imagePreviewDrag';

describe('annotated image drag', () => {
  afterEach(() => {
    clearCurrentDraggedAnnotatedImage();
  });

  it('starts a hold-to-drag only after the press stays still', () => {
    expect(shouldStartLongPressDrag(200, 0)).toBe(false);
    expect(shouldStartLongPressDrag(450, 12)).toBe(false);
    expect(shouldStartLongPressDrag(450, 2)).toBe(true);
    expect(shouldCancelLongPress(9)).toBe(true);
  });

  it('drops the in-memory marked file onto a composer zone', () => {
    const file = new File(['marked'], 'shot-marked.png', { type: 'image/png' });
    setCurrentDraggedAnnotatedImage(file);
    expect(getCurrentDraggedAnnotatedImage()).toBe(file);

    const zone = document.createElement('div');
    zone.setAttribute('data-file-reference-drop-zone', '');
    document.body.append(zone);
    zone.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 100,
        bottom: 100,
        width: 100,
        height: 100,
        x: 0,
        y: 0,
        toJSON() {
          return this;
        },
      }) as DOMRect;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => zone;

    const dropped: File[] = [];
    zone.addEventListener('vibex-annotated-image-drop', (event) => {
      dropped.push((event as CustomEvent<File>).detail);
    });

    expect(dispatchAnnotatedImageDrop(20, 20)).toBe(true);
    expect(dropped).toEqual([file]);

    document.elementFromPoint = original;
    zone.remove();
  });
});
