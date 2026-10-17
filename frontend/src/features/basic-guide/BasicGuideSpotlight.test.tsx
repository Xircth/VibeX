import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BasicGuideSpotlight } from './BasicGuideSpotlight';
import { BASIC_GUIDE_IDLE_MS } from './spotlightGeometry';

describe('BasicGuideSpotlight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('uses a circular box and flashes after 5s idle', () => {
    const button = document.createElement('button');
    button.dataset.basicGuide = 'toolbar-new-session';
    document.body.appendChild(button);
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      x: 900,
      y: 12,
      top: 12,
      left: 900,
      width: 28,
      height: 28,
      bottom: 40,
      right: 928,
      toJSON() {
        return {};
      },
    } as DOMRect);

    render(
      <BasicGuideSpotlight
        targets={[
          {
            id: 'toolbar-new-session',
            copyKey: 'click-new-session',
            shape: 'circle',
          },
        ]}
        resolveCopy={() => '首先，点击此按钮以创建会话'}
        panelSelector="[data-basic-guide-panel]"
      />
    );

    const box = document.querySelector('.basic-guide-spotlight');
    expect(box).toHaveAttribute('data-shape', 'circle');
    expect(box).toHaveClass('basic-guide-spotlight--circle');
    expect(box).not.toHaveClass('is-idle');
    expect(screen.getByText('点击')).toHaveClass('basic-guide-action');

    act(() => {
      vi.advanceTimersByTime(BASIC_GUIDE_IDLE_MS);
    });
    expect(document.querySelector('.basic-guide-spotlight')).toHaveClass(
      'is-idle'
    );
  });
});
