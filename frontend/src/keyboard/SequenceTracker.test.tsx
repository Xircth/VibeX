import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  SHORTCUT_ACTION_EVENT,
  SequenceTrackerProvider,
} from './SequenceTracker';

describe('SequenceTrackerProvider', () => {
  it('dispatches the registered action after a valid two-key sequence', () => {
    const listener = vi.fn();
    window.addEventListener(SHORTCUT_ACTION_EVENT, listener);

    render(
      <SequenceTrackerProvider>
        <div>workspace</div>
      </SequenceTrackerProvider>
    );

    fireEvent.keyDown(window, { key: 'g', code: 'KeyG' });
    fireEvent.keyDown(window, { key: 's', code: 'KeyS' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      actionId: 'settings',
    });

    window.removeEventListener(SHORTCUT_ACTION_EVENT, listener);
  });
});
