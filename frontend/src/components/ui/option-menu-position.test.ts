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

  it('converges without Maximum update depth exceeded for border-box menus with inner scroll containers', async () => {
    const { renderHook, act } = await import('@testing-library/react');
    const { useOptionMenuPlacement } = await import('./option-menu-position');

    const trigger = document.createElement('button');
    trigger.getBoundingClientRect = () =>
      ({
        top: 24,
        bottom: 52,
        left: 20,
        width: 132,
        right: 152,
        height: 28,
        x: 20,
        y: 24,
        toJSON: () => ({}),
      }) as DOMRect;

    const menu = document.createElement('div');
    menu.style.boxSizing = 'border-box';
    menu.style.borderTopWidth = '1px';
    menu.style.borderBottomWidth = '1px';
    menu.style.borderStyle = 'solid';
    const scrollChild = document.createElement('div');
    scrollChild.style.overflowY = 'auto';
    menu.append(scrollChild);
    document.body.append(trigger, menu);

    // Simulate border-box clamping: maxHeight M clamps menu inner height to M - 2
    // and scrollChild clientHeight by the same deficit while scrollChild.scrollHeight
    // stays at the full 36px option height (natural total = 88px including 2px border).
    Object.defineProperty(menu, 'offsetWidth', {
      value: 260,
      configurable: true,
    });
    Object.defineProperty(menu, 'scrollHeight', {
      configurable: true,
      get: () => {
        const applied = Number.parseFloat(menu.style.maxHeight || '320');
        return applied < 88 ? Math.max(0, applied - 2) : 86;
      },
    });
    Object.defineProperty(scrollChild, 'scrollHeight', {
      value: 36,
      configurable: true,
    });
    Object.defineProperty(scrollChild, 'clientHeight', {
      configurable: true,
      get: () => {
        const applied = Number.parseFloat(menu.style.maxHeight || '320');
        return applied < 88 ? Math.max(0, 36 - (88 - applied)) : 36;
      },
    });

    const triggerRef = { current: trigger };
    const menuRef = { current: menu };

    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) =>
        useOptionMenuPlacement(open, triggerRef, menuRef),
      { initialProps: { open: false } }
    );

    act(() => {
      rerender({ open: true });
    });
    if (result.current) {
      menu.style.maxHeight = `${result.current.maxHeight}px`;
    }
    act(() => {
      rerender({ open: true });
    });

    expect(result.current?.width).toBe(260);
    expect(result.current?.maxHeight).toBe(88);

    trigger.remove();
    menu.remove();
  });

  it('keeps long scrollable menus anchored below the trigger instead of covering it when spaceBelow is comfortable', () => {
    const position = getMenuPosition(
      { top: 180, bottom: 212, left: 40, width: 320 },
      false,
      800,
      2000,
      1200
    );

    expect(position.top).toBe(216);
    expect(position.maxHeight).toBe(576);
    expect(position.top + position.maxHeight).toBe(792);
  });

  it('covers the viewport only when neither side has comfortable room to scroll', () => {
    const position = getMenuPosition(
      { top: 140, bottom: 172, left: 40, width: 320 },
      false,
      300,
      2000,
      1200
    );

    expect(position.top).toBe(8);
    expect(position.maxHeight).toBe(284);
  });

  it('reduces available maxHeight by maxHeightRatio for tall overflowing menus while keeping short menus unclipped', () => {
    const tall = getMenuPosition(
      { top: 180, bottom: 212, left: 40, width: 320 },
      false,
      800,
      2000,
      1200,
      320,
      0.85
    );
    expect(tall.top).toBe(216);
    expect(tall.maxHeight).toBe(Math.round(576 * 0.85));

    const short = getMenuPosition(
      { top: 180, bottom: 212, left: 40, width: 320 },
      false,
      800,
      200,
      1200,
      320,
      0.85
    );
    expect(short.top).toBe(216);
    expect(short.maxHeight).toBe(200);
  });
});
