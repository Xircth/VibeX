import {
  closestCenter,
  type ClientRect,
  type CollisionDetection,
} from '@dnd-kit/core';
import { describe, expect, it } from 'vitest';
import { sessionHubDropCollision } from './sessionHubCollision';

function rect(top: number, height: number): ClientRect {
  return {
    top,
    left: 0,
    width: 240,
    height,
    right: 240,
    bottom: top + height,
  };
}

function collisionArgs(pointerY: number): Parameters<CollisionDetection>[0] {
  const inReview = rect(0, 80);
  const done = rect(80, 400);
  return {
    active: {
      id: 'session-1',
      data: { current: undefined },
      rect: { current: { initial: null, translated: null } },
    },
    collisionRect: rect(pointerY - 8, 16),
    droppableRects: new Map([
      ['session-status-drop:inreview', inReview],
      ['session-status-drop:done', done],
    ]),
    droppableContainers: [
      {
        id: 'session-status-drop:inreview',
        key: 'inreview',
        disabled: false,
        data: { current: undefined },
        node: { current: null },
        rect: { current: inReview },
      },
      {
        id: 'session-status-drop:done',
        key: 'done',
        disabled: false,
        data: { current: undefined },
        node: { current: null },
        rect: { current: done },
      },
    ],
    pointerCoordinates: { x: 24, y: pointerY },
  };
}

describe('sessionHubDropCollision', () => {
  it('highlights the done column when the pointer is over its header', () => {
    const args = collisionArgs(96);
    expect(closestCenter(args)[0]?.id).toBe('session-status-drop:inreview');

    expect(sessionHubDropCollision(args, { canvasDrop: false })[0]?.id).toBe(
      'session-status-drop:done'
    );
  });

  it('keeps the column under the pointer when that column is not done', () => {
    const args = collisionArgs(20);
    expect(sessionHubDropCollision(args, { canvasDrop: false })[0]?.id).toBe(
      'session-status-drop:inreview'
    );
  });

  it('does not snap a canvas drop to a distant status column', () => {
    const args = collisionArgs(-40);
    expect(sessionHubDropCollision(args, { canvasDrop: true })).toEqual([]);
    expect(sessionHubDropCollision(args, { canvasDrop: false })[0]?.id).toBe(
      'session-status-drop:inreview'
    );
  });
});
