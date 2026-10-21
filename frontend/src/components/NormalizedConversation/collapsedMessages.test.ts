import { describe, expect, it } from 'vitest';
import type { TurnRenderItem } from './messageTurnBlocks';
import {
  collapsedMessagesDurationMs,
  formatCollapsedDurationParts,
} from './collapsedMessages';

function tool(
  startedAt: string | null,
  endedAt: string | null
): TurnRenderItem {
  return {
    kind: 'tool',
    use: {
      type: 'tool_use',
      tool_name: 'Read',
      started_at: startedAt,
      ended_at: endedAt,
    },
    result: null,
  };
}

describe('collapsed process label duration', () => {
  it('formats a positive span as hours and minutes', () => {
    expect(formatCollapsedDurationParts(90 * 60 * 1000)).toEqual({
      hours: 1,
      minutes: 30,
    });
    expect(formatCollapsedDurationParts(30 * 1000)).toEqual({
      hours: 0,
      minutes: 1,
    });
    expect(formatCollapsedDurationParts(60 * 60 * 1000)).toEqual({
      hours: 1,
      minutes: 0,
    });
  });

  it('uses the tool wall-clock span and ignores an epoch placeholder', () => {
    expect(
      collapsedMessagesDurationMs({
        items: [
          tool('2026-10-19T10:00:00.000Z', '2026-10-19T10:20:00.000Z'),
          tool('2026-10-19T10:20:00.000Z', '2026-10-19T11:30:00.000Z'),
          tool('1970-01-01T00:00:00.000Z', null),
        ],
        settled: true,
        durationMs: 497894 * 60 * 60 * 1000,
      })
    ).toBe(90 * 60 * 1000);
  });

  it('falls back to a settled turn duration when tool stamps are missing', () => {
    expect(
      collapsedMessagesDurationMs({
        items: [tool(null, null)],
        settled: true,
        turnTimestamp: '2026-10-19T10:00:00.000Z',
        completedAt: '2026-10-19T12:15:00.000Z',
      })
    ).toBe(135 * 60 * 1000);
  });

  it('counts forward from a plausible start while the turn is unfinished', () => {
    expect(
      collapsedMessagesDurationMs({
        items: [tool(null, null)],
        settled: false,
        turnTimestamp: '2026-10-19T09:00:00.000Z',
        nowMs: Date.parse('2026-10-19T10:13:00.000Z'),
      })
    ).toBe(73 * 60 * 1000);
    expect(
      collapsedMessagesDurationMs({
        items: [tool(null, null)],
        settled: false,
        turnTimestamp: '1970-01-01T00:00:00.000Z',
        nowMs: Date.parse('2026-10-19T10:13:00.000Z'),
      })
    ).toBeNull();
  });

  it('does not invent a span for a streaming fold or an epoch duration', () => {
    expect(
      collapsedMessagesDurationMs({
        items: [tool(null, null)],
        settled: false,
        turnTimestamp: '2026-10-19T10:00:00.000Z',
        durationMs: 5 * 60 * 1000,
      })
    ).toBeNull();
    expect(
      collapsedMessagesDurationMs({
        items: [tool(null, null)],
        settled: true,
        turnTimestamp: '1970-01-01T00:00:00.000Z',
        completedAt: '2026-10-19T12:00:00.000Z',
        durationMs: 497894 * 60 * 60 * 1000,
      })
    ).toBeNull();
  });
});
