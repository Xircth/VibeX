import { describe, expect, it } from 'vitest';

import {
  collectFloatingLayers,
  FLOATING_LAYER_ATTR,
  isModalFloatingLayer,
  mergeFloatingLayerOcclusion,
  mutationTouchesFloatingLayer,
  uniqueOverlayRects,
} from './floatingLayer';

function box(x: number, y: number, width: number, height: number) {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  };
}

describe('collectFloatingLayers', () => {
  it('treats aria-modal dialogs as a full-surface hide', () => {
    const root = document.createElement('div');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.getBoundingClientRect = () => box(200, 80, 480, 360);
    root.append(dialog);
    expect(isModalFloatingLayer(dialog)).toBe(true);
    expect(collectFloatingLayers(root)).toEqual({
      hide: true,
      rects: [{ x: 200, y: 80, width: 480, height: 360 }],
    });
  });

  it('publishes popover rectangles without hiding the whole surface', () => {
    const root = document.createElement('div');
    const menu = document.createElement('div');
    menu.setAttribute(FLOATING_LAYER_ATTR, 'popover');
    menu.getBoundingClientRect = () => box(620, 40, 180, 220);
    root.append(menu);
    expect(collectFloatingLayers(root)).toEqual({
      hide: false,
      rects: [{ x: 620, y: 40, width: 180, height: 220 }],
    });
  });

  it('hides the native surface for a modal even before it has a box', () => {
    const root = document.createElement('div');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.getBoundingClientRect = () => box(0, 0, 0, 0);
    root.append(dialog);
    expect(collectFloatingLayers(root)).toEqual({
      hide: true,
      rects: [],
    });
  });

  it('ignores closed radix layers and empty boxes', () => {
    const root = document.createElement('div');
    const closed = document.createElement('div');
    closed.setAttribute(FLOATING_LAYER_ATTR, 'popover');
    closed.setAttribute('data-state', 'closed');
    closed.getBoundingClientRect = () => box(10, 10, 80, 40);
    const empty = document.createElement('div');
    empty.setAttribute(FLOATING_LAYER_ATTR, 'popover');
    empty.getBoundingClientRect = () => box(0, 0, 0, 0);
    root.append(closed, empty);
    expect(collectFloatingLayers(root)).toEqual({
      hide: false,
      rects: [],
    });
  });

  it('reads the parent box of an occlusion hold marker', () => {
    const root = document.createElement('div');
    const overlay = document.createElement('div');
    overlay.getBoundingClientRect = () => box(0, 0, 1280, 800);
    const hold = document.createElement('span');
    hold.setAttribute('data-native-surface-occlusion', '');
    hold.getBoundingClientRect = () => box(0, 0, 0, 0);
    overlay.append(hold);
    root.append(overlay);
    expect(collectFloatingLayers(root)).toEqual({
      hide: false,
      rects: [{ x: 0, y: 0, width: 1280, height: 800 }],
    });
  });
});

describe('uniqueOverlayRects', () => {
  it('drops duplicate boxes from hold + observer', () => {
    expect(
      uniqueOverlayRects([
        { x: 10, y: 10, width: 40, height: 20 },
        { x: 10, y: 10, width: 40, height: 20 },
      ])
    ).toEqual([{ x: 10, y: 10, width: 40, height: 20 }]);
  });
});

describe('mutationTouchesFloatingLayer', () => {
  it('ignores ordinary document edits and notices a mounted dialog', () => {
    const root = document.createElement('div');
    const text = document.createElement('p');
    text.textContent = 'stream';
    root.append(text);
    expect(
      mutationTouchesFloatingLayer([
        {
          type: 'childList',
          target: root,
          addedNodes: [text] as unknown as NodeList,
          removedNodes: [] as unknown as NodeList,
          attributeName: null,
          attributeNamespace: null,
          nextSibling: null,
          previousSibling: null,
          oldValue: null,
        } as MutationRecord,
      ])
    ).toBe(false);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    expect(
      mutationTouchesFloatingLayer([
        {
          type: 'childList',
          target: root,
          addedNodes: [dialog] as unknown as NodeList,
          removedNodes: [] as unknown as NodeList,
          attributeName: null,
          attributeNamespace: null,
          nextSibling: null,
          previousSibling: null,
          oldValue: null,
        } as MutationRecord,
      ])
    ).toBe(true);
  });
});

describe('mergeFloatingLayerOcclusion', () => {
  it('raises hide if any layer is modal', () => {
    expect(
      mergeFloatingLayerOcclusion([
        { hide: false, rects: [{ x: 1, y: 1, width: 2, height: 2 }] },
        { hide: true, rects: [{ x: 8, y: 8, width: 4, height: 4 }] },
      ])
    ).toEqual({
      hide: true,
      rects: [
        { x: 1, y: 1, width: 2, height: 2 },
        { x: 8, y: 8, width: 4, height: 4 },
      ],
    });
  });
});
