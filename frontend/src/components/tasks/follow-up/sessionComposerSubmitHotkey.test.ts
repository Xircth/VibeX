import { describe, expect, it } from 'vitest';

import { composerBareEnterInsertsNewline } from './sessionComposerSubmitHotkey';

describe('composerBareEnterInsertsNewline', () => {
  it('lets Enter send when the setting is Enter', () => {
    expect(
      composerBareEnterInsertsNewline('Enter', {
        key: 'Enter',
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
      })
    ).toBe(false);
  });

  it('turns bare Enter into a newline when the setting is modifier+Enter', () => {
    expect(
      composerBareEnterInsertsNewline('ModifierEnter', {
        key: 'Enter',
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
      })
    ).toBe(true);
  });

  it('still sends on modifier+Enter', () => {
    expect(
      composerBareEnterInsertsNewline('ModifierEnter', {
        key: 'Enter',
        shiftKey: false,
        metaKey: true,
        ctrlKey: false,
      })
    ).toBe(false);
  });
});
