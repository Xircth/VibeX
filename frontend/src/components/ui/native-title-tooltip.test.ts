import { describe, expect, it } from 'vitest';
import {
  findTitledElement,
  positionHoverTooltip,
  restoreNativeTitle,
  suppressNativeTitle,
} from './native-title-tooltip';

describe('native title tooltip helpers', () => {
  it('ignores empty titles, the document root, and tooltip chrome', () => {
    const labeled = document.createElement('button');
    labeled.setAttribute('title', '   ');
    document.body.append(labeled);

    const astryxTooltip = document.createElement('div');
    astryxTooltip.className = 'astryx-tooltip';
    astryxTooltip.setAttribute('title', '内部');
    document.body.append(astryxTooltip);

    expect(findTitledElement(labeled)).toBeNull();
    expect(findTitledElement(document.documentElement)).toBeNull();
    expect(findTitledElement(astryxTooltip)).toBeNull();

    labeled.remove();
    astryxTooltip.remove();
  });

  it('suppresses the native title while the custom tooltip is showing', () => {
    const button = document.createElement('button');
    button.setAttribute('title', '打开项目');
    document.body.append(button);

    expect(findTitledElement(button)).toBe(button);
    expect(suppressNativeTitle(button)).toBe('打开项目');
    expect(button.hasAttribute('title')).toBe(false);
    expect(button.getAttribute('data-app-title')).toBe('打开项目');

    restoreNativeTitle(button);
    expect(button.getAttribute('title')).toBe('打开项目');
    expect(button.hasAttribute('data-app-title')).toBe(false);

    button.remove();
  });

  it('keeps the capsule inside the viewport and flips above when needed', () => {
    const below = positionHoverTooltip(
      { top: 8, left: 40, width: 24, height: 24 },
      { width: 80, height: 24 },
      { width: 400, height: 300 }
    );
    expect(below.top).toBe(38);
    expect(below.left).toBe(12);

    const above = positionHoverTooltip(
      { top: 280, left: 10, width: 20, height: 16 },
      { width: 120, height: 28 },
      { width: 200, height: 300 }
    );
    expect(above.top).toBe(246);
    expect(above.left).toBe(8);
  });
});
