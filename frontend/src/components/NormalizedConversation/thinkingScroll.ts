export type ThinkingWheelTarget = 'conversation' | 'inner';

const EDGE_PX = 1;

/**
 * Nested thinking pane vs the conversation scroller.
 * Streaming never uses the inner pane. A finished pane only keeps the
 * wheel when it actually overflows and is not already at that edge.
 */
export function thinkingWheelTarget(input: {
  isStreaming: boolean;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  deltaY: number;
}): ThinkingWheelTarget {
  if (input.isStreaming) return 'conversation';
  const overflow = input.scrollHeight - input.clientHeight;
  if (overflow <= EDGE_PX) return 'conversation';
  if (input.deltaY < 0 && input.scrollTop <= EDGE_PX) return 'conversation';
  if (input.deltaY > 0 && input.scrollTop >= overflow - EDGE_PX) {
    return 'conversation';
  }
  return 'inner';
}
