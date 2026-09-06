import { describe, expect, it } from 'vitest';

import {
  astryxHandlesComposerSubmit,
  composerBareEnterInsertsNewline,
  composerEnterAction,
  isComposerEnterKey,
  isComposerImeCommitEnter,
  isComposerImeComposing,
} from './sessionComposerSubmitHotkey';

function enterEvent(
  overrides: Partial<{
    key: string;
    code: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    isComposing: boolean;
    keyCode: number;
  }> = {}
) {
  const {
    key = 'Enter',
    code = 'Enter',
    shiftKey = false,
    metaKey = false,
    ctrlKey = false,
    isComposing = false,
    keyCode = 13,
  } = overrides;
  return {
    key,
    code,
    shiftKey,
    metaKey,
    ctrlKey,
    isComposing,
    nativeEvent: { isComposing, keyCode },
  };
}

describe('composerBareEnterInsertsNewline', () => {
  it('lets Enter send when the setting is Enter', () => {
    expect(composerBareEnterInsertsNewline('Enter', enterEvent())).toBe(false);
  });

  it('turns bare Enter into a newline when the setting is modifier+Enter', () => {
    expect(composerBareEnterInsertsNewline('ModifierEnter', enterEvent())).toBe(
      true
    );
  });

  it('still sends on modifier+Enter', () => {
    expect(
      composerBareEnterInsertsNewline(
        'ModifierEnter',
        enterEvent({ metaKey: true })
      )
    ).toBe(false);
  });

  it('treats Unidentified+Enter code as Enter for the modifier+Enter setting', () => {
    expect(
      composerBareEnterInsertsNewline(
        'ModifierEnter',
        enterEvent({ key: 'Unidentified' })
      )
    ).toBe(true);
  });
});

describe('isComposerEnterKey', () => {
  it('matches Enter by key or code', () => {
    expect(isComposerEnterKey({ key: 'Enter' })).toBe(true);
    expect(isComposerEnterKey({ key: 'NumpadEnter' })).toBe(true);
    expect(isComposerEnterKey({ key: 'Unidentified', code: 'Enter' })).toBe(
      true
    );
    expect(isComposerEnterKey({ key: 'a', code: 'KeyA' })).toBe(false);
  });
});

describe('isComposerImeComposing', () => {
  it('ignores Windows WebView2 keyCode 229 on a resolved Enter', () => {
    expect(
      isComposerImeComposing(enterEvent({ keyCode: 229, isComposing: false }))
    ).toBe(false);
  });

  it('treats active composition and Process keys as IME', () => {
    expect(isComposerImeComposing(enterEvent({ isComposing: true }))).toBe(
      true
    );
    expect(isComposerImeComposing({ key: 'Process' })).toBe(true);
  });
});

describe('composerEnterAction', () => {
  it('defers a normal Enter so Astryx can submit', () => {
    expect(composerEnterAction('Enter', enterEvent())).toBe('defer');
    expect(astryxHandlesComposerSubmit(enterEvent())).toBe(true);
  });

  it('submits when Windows WebView2 reports Enter with keyCode 229', () => {
    expect(composerEnterAction('Enter', enterEvent({ keyCode: 229 }))).toBe(
      'submit'
    );
  });

  it('submits when Enter is Unidentified but code is Enter', () => {
    expect(
      composerEnterAction(
        'Enter',
        enterEvent({ key: 'Unidentified', keyCode: 13 })
      )
    ).toBe('submit');
  });

  it('does not submit during IME composition', () => {
    expect(
      composerEnterAction(
        'Enter',
        enterEvent({ isComposing: true, keyCode: 229 })
      )
    ).toBe('defer');
  });

  it('does not submit the Enter that commits an IME candidate', () => {
    const now = 1_000;
    expect(
      isComposerImeCommitEnter(enterEvent({ keyCode: 229 }), 980, now)
    ).toBe(true);
    expect(
      composerEnterAction('Enter', enterEvent({ keyCode: 229 }), 980, now)
    ).toBe('defer');
  });

  it('does not submit Shift+Enter even with keyCode 229', () => {
    expect(
      composerEnterAction('Enter', enterEvent({ shiftKey: true, keyCode: 229 }))
    ).toBe('defer');
  });
});
