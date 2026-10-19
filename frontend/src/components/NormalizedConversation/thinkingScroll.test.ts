import { describe, expect, it } from 'vitest';
import { thinkingWheelTarget } from './thinkingScroll';

describe('thinkingWheelTarget', () => {
  it('sends every wheel to the conversation while thinking is streaming', () => {
    expect(
      thinkingWheelTarget({
        isStreaming: true,
        scrollTop: 40,
        clientHeight: 80,
        scrollHeight: 400,
        deltaY: 24,
      })
    ).toBe('conversation');
    expect(
      thinkingWheelTarget({
        isStreaming: true,
        scrollTop: 0,
        clientHeight: 80,
        scrollHeight: 80,
        deltaY: -24,
      })
    ).toBe('conversation');
  });

  it('sends the wheel to the conversation when finished thinking does not overflow', () => {
    expect(
      thinkingWheelTarget({
        isStreaming: false,
        scrollTop: 0,
        clientHeight: 120,
        scrollHeight: 80,
        deltaY: 32,
      })
    ).toBe('conversation');
  });

  it('keeps an overflowing finished pane until the wheel hits an edge', () => {
    expect(
      thinkingWheelTarget({
        isStreaming: false,
        scrollTop: 40,
        clientHeight: 100,
        scrollHeight: 400,
        deltaY: 24,
      })
    ).toBe('inner');
    expect(
      thinkingWheelTarget({
        isStreaming: false,
        scrollTop: 0,
        clientHeight: 100,
        scrollHeight: 400,
        deltaY: 24,
      })
    ).toBe('inner');
    expect(
      thinkingWheelTarget({
        isStreaming: false,
        scrollTop: 300,
        clientHeight: 100,
        scrollHeight: 400,
        deltaY: -24,
      })
    ).toBe('inner');
  });

  it('chains to the conversation at the top and bottom of finished thinking', () => {
    expect(
      thinkingWheelTarget({
        isStreaming: false,
        scrollTop: 0,
        clientHeight: 100,
        scrollHeight: 400,
        deltaY: -24,
      })
    ).toBe('conversation');
    expect(
      thinkingWheelTarget({
        isStreaming: false,
        scrollTop: 300,
        clientHeight: 100,
        scrollHeight: 400,
        deltaY: 24,
      })
    ).toBe('conversation');
  });
});
