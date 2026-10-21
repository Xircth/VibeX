import { describe, expect, it } from 'vitest';
import {
  bindNestedWheel,
  nestedWheelResult,
  wheelDeltaPixels,
  type ScrollMetrics,
} from './nestedScroll';

function layer(
  partial: Partial<ScrollMetrics> &
    Pick<ScrollMetrics, 'scrollTop' | 'clientHeight' | 'scrollHeight'>
): ScrollMetrics {
  return partial;
}

describe('nestedWheelResult', () => {
  it('scrolls the next nested pane when the inner one cannot move', () => {
    expect(
      nestedWheelResult(
        [
          layer({ scrollTop: 0, clientHeight: 120, scrollHeight: 80 }),
          layer({ scrollTop: 12, clientHeight: 200, scrollHeight: 800 }),
        ],
        32
      )
    ).toEqual({ kind: 'scroll', index: 1 });
  });

  it('keeps an overflowing inner pane until the wheel hits an edge', () => {
    expect(
      nestedWheelResult(
        [
          layer({ scrollTop: 40, clientHeight: 100, scrollHeight: 400 }),
          layer({ scrollTop: 12, clientHeight: 200, scrollHeight: 800 }),
        ],
        24
      )
    ).toEqual({ kind: 'scroll', index: 0 });
    expect(
      nestedWheelResult(
        [
          layer({ scrollTop: 0, clientHeight: 100, scrollHeight: 400 }),
          layer({ scrollTop: 12, clientHeight: 200, scrollHeight: 800 }),
        ],
        -24
      )
    ).toEqual({ kind: 'scroll', index: 1 });
  });

  it('walks outward from a nested edge before the conversation', () => {
    expect(
      nestedWheelResult(
        [
          layer({ scrollTop: 300, clientHeight: 100, scrollHeight: 400 }),
          layer({ scrollTop: 0, clientHeight: 100, scrollHeight: 400 }),
          layer({
            scrollTop: 12,
            clientHeight: 200,
            scrollHeight: 800,
            conversation: true,
          }),
        ],
        24
      )
    ).toEqual({ kind: 'scroll', index: 1 });
    expect(
      nestedWheelResult(
        [
          layer({ scrollTop: 300, clientHeight: 100, scrollHeight: 400 }),
          layer({ scrollTop: 300, clientHeight: 100, scrollHeight: 400 }),
          layer({
            scrollTop: 12,
            clientHeight: 200,
            scrollHeight: 800,
            conversation: true,
          }),
        ],
        24
      )
    ).toEqual({ kind: 'native' });
  });

  it('does not intercept when no nested pane can consume the wheel', () => {
    expect(
      nestedWheelResult(
        [
          layer({ scrollTop: 300, clientHeight: 100, scrollHeight: 400 }),
          layer({ scrollTop: 300, clientHeight: 100, scrollHeight: 400 }),
        ],
        24
      )
    ).toEqual({ kind: 'native' });
  });
});

describe('wheelDeltaPixels', () => {
  it('keeps pixel deltas and converts line/page modes', () => {
    expect(wheelDeltaPixels({ deltaY: 48, deltaMode: 0 })).toBe(48);
    expect(wheelDeltaPixels({ deltaY: 3, deltaMode: 1 })).toBe(48);
    expect(wheelDeltaPixels({ deltaY: 1, deltaMode: 2 })).toBe(800);
  });
});

function stubScroll(
  el: HTMLElement,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number
) {
  let top = scrollTop;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    value: clientHeight,
  });
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    value: scrollHeight,
  });
}

function wheel(deltaY: number) {
  return new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
}

describe('bindNestedWheel', () => {
  it('scrolls the pane under the pointer until its edge', () => {
    const node = document.createElement('div');
    node.setAttribute('data-nested-scroll', '');
    const child = document.createElement('div');
    node.append(child);
    stubScroll(node, 40, 100, 400);
    const unbind = bindNestedWheel(node);
    const event = wheel(48);
    child.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(node.scrollTop).toBe(88);
    unbind();
  });

  it('scrolls the tool fold after thinking reaches its edge', () => {
    const conversation = document.createElement('div');
    conversation.setAttribute('data-panel', 'conversation-logs');
    const fold = document.createElement('div');
    fold.setAttribute('data-nested-scroll', '');
    const thinking = document.createElement('div');
    thinking.setAttribute('data-nested-scroll', '');
    const child = document.createElement('p');
    conversation.append(fold);
    fold.append(thinking);
    thinking.append(child);
    document.body.append(conversation);
    stubScroll(thinking, 300, 100, 400);
    stubScroll(fold, 8, 100, 400);
    stubScroll(conversation, 12, 200, 800);
    const unbindThinking = bindNestedWheel(thinking);
    const unbindFold = bindNestedWheel(fold);
    child.dispatchEvent(wheel(48));
    expect(thinking.scrollTop).toBe(300);
    expect(fold.scrollTop).toBe(56);
    expect(conversation.scrollTop).toBe(12);
    unbindThinking();
    unbindFold();
    conversation.remove();
  });

  it('leaves the conversation wheel alone once every nested pane is at its edge', () => {
    const conversation = document.createElement('div');
    conversation.setAttribute('data-panel', 'conversation-logs');
    const thinking = document.createElement('div');
    thinking.setAttribute('data-nested-scroll', '');
    conversation.append(thinking);
    document.body.append(conversation);
    stubScroll(thinking, 300, 100, 400);
    stubScroll(conversation, 12, 200, 800);
    const unbind = bindNestedWheel(thinking);
    const event = wheel(48);
    thinking.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(thinking.scrollTop).toBe(300);
    expect(conversation.scrollTop).toBe(12);
    unbind();
    conversation.remove();
  });
});
