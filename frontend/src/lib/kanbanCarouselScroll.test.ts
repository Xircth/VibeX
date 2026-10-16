import { describe, expect, it, vi } from 'vitest';
import {
  consumeKanbanCarouselPageKey,
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
    expect(shouldSuppressKanbanCarouselPageKey(document.body)).toBe(true);

    conversation.remove();
    canvas.remove();
  });

  it('pins page keys aimed at the document without taking them from a field', () => {
    const shell = { scrollLeft: 800, scrollTop: 40 };
    const pageDown = {
      key: 'PageDown',
      target: document.body,
      preventDefault: vi.fn(),
    };

    consumeKanbanCarouselPageKey(pageDown, shell);

    expect(pageDown.preventDefault).toHaveBeenCalledTimes(1);
    expect(shell).toEqual({ scrollLeft: 0, scrollTop: 0 });

    const field = document.createElement('textarea');
    const fieldEvent = {
      key: 'PageDown',
      target: field,
      preventDefault: vi.fn(),
    };
    shell.scrollLeft = 12;
    consumeKanbanCarouselPageKey(fieldEvent, shell);

    expect(fieldEvent.preventDefault).not.toHaveBeenCalled();
    expect(shell.scrollLeft).toBe(12);
  });
});
