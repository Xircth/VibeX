import { describe, expect, it } from 'vitest';
import {
  pinKanbanCarouselScroll,
  shouldPinKanbanCarouselKey,
  shouldSuppressKanbanCarouselPageKey,
} from './kanbanCarouselScroll';

describe('kanbanCarouselScroll', () => {
  it('treats PageDown and PageUp as carousel-page keys', () => {
    expect(shouldPinKanbanCarouselKey('PageDown')).toBe(true);
    expect(shouldPinKanbanCarouselKey('PageUp')).toBe(true);
    expect(shouldPinKanbanCarouselKey('Home')).toBe(true);
    expect(shouldPinKanbanCarouselKey('End')).toBe(true);
    expect(shouldPinKanbanCarouselKey('ArrowDown')).toBe(false);
    expect(shouldPinKanbanCarouselKey('Enter')).toBe(false);
  });

  it('snaps a drifted carousel shell back to the origin', () => {
    const element = {
      scrollLeft: 640,
      scrollTop: 12,
    };

    pinKanbanCarouselScroll(element);

    expect(element.scrollLeft).toBe(0);
    expect(element.scrollTop).toBe(0);
  });

  it('lets PageDown scroll a conversation, not the canvas carousel', () => {
    const conversation = document.createElement('div');
    conversation.setAttribute('data-panel', 'conversation-logs');
    const message = document.createElement('p');
    conversation.appendChild(message);
    document.body.appendChild(conversation);

    const canvas = document.createElement('div');
    canvas.setAttribute('data-panel', 'kanban');
    document.body.appendChild(canvas);

    expect(shouldSuppressKanbanCarouselPageKey(message)).toBe(false);
    expect(shouldSuppressKanbanCarouselPageKey(canvas)).toBe(true);

    conversation.remove();
    canvas.remove();
  });
});
