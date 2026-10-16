import { describe, expect, it } from 'vitest';

import { fitOptionMenuElement, getMenuPosition } from './option-menu-position';

describe('option menu placement', () => {
  it('keeps a menu near the top edge fully inside the viewport', () => {
    const position = getMenuPosition(
      { top: 12, bottom: 40, left: 16, width: 160 },
      false,
      800,
      220,
      1200
    );

    expect(position.top).toBe(44);
    expect(position.top + position.maxHeight).toBeLessThanOrEqual(792);
    expect(position.maxHeight).toBe(220);
  });

  it('shifts a menu that would leave the right edge', () => {
    const position = getMenuPosition(
      { top: 100, bottom: 132, left: 900, width: 200 },
      false,
      800,
      80,
      1000
    );

    expect(position.left + position.width).toBeLessThanOrEqual(992);
    expect(position.left).toBeGreaterThanOrEqual(8);
  });

  it('replaces a selected-item anchor with a viewport-safe block', () => {
    const trigger = document.createElement('button');
    trigger.setAttribute('aria-controls', 'mode-list');
    document.body.append(trigger);
    trigger.getBoundingClientRect = () =>
      ({
        top: 24,
        bottom: 52,
        left: 20,
        width: 140,
        right: 160,
        height: 28,
        x: 20,
        y: 24,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    const popover = document.createElement('div');
    popover.setAttribute('popover', 'auto');
    popover.style.marginTop = '-80px';
    const listbox = document.createElement('div');
    listbox.id = 'mode-list';
    listbox.setAttribute('role', 'listbox');
    popover.append(listbox);
    document.body.append(popover);
    Object.defineProperty(popover, 'scrollHeight', { value: 180 });
    Object.defineProperty(popover, 'offsetWidth', { value: 140 });

    fitOptionMenuElement(popover);

    const top = Number.parseFloat(popover.style.top);
    const maxHeight = Number.parseFloat(popover.style.maxHeight);
    expect(popover.style.position).toBe('fixed');
    expect(popover.style.margin).toBe('0px');
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + maxHeight).toBeLessThanOrEqual(window.innerHeight - 8);
    expect(maxHeight).toBeGreaterThan(0);

    popover.remove();
    trigger.remove();
  });

  it('leaves composer trigger menus on their own anchor', () => {
    const popover = document.createElement('div');
    popover.setAttribute('popover', 'auto');
    popover.style.marginTop = '-80px';
    const listbox = document.createElement('div');
    listbox.id = 'trigger-list';
    listbox.className = 'astryx-trigger-menu';
    listbox.setAttribute('role', 'listbox');
    popover.append(listbox);
    document.body.append(popover);

    fitOptionMenuElement(popover);

    expect(popover.style.position).toBe('');
    expect(popover.style.marginTop).toBe('-80px');

    popover.remove();
  });
});
