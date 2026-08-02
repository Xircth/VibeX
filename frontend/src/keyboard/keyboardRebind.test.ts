import { describe, expect, it } from 'vitest';

import { chordFromEvent, formatChord } from './chord';
import {
  Action,
  Scope,
  bindingKey,
  getConfigurableKeyBindings,
  getEffectiveKeyBindings,
  getKeysFor,
  findChordConflicts,
  keyBindings,
  sequentialBindings,
} from './registry';

function evt(partial: Partial<Parameters<typeof chordFromEvent>[0]>) {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

describe('chordFromEvent', () => {
  it('derives the base key from the physical code, not the shifted key', () => {
    // Shift + `/` yields key '?' but code 'Slash' — must produce shift+slash
    // to match the registry (Action.SHOW_HELP uses shift+slash).
    expect(chordFromEvent(evt({ key: '?', code: 'Slash', shiftKey: true }))).toBe(
      'shift+slash'
    );
  });

  it('orders modifiers meta, ctrl, alt, shift', () => {
    expect(
      chordFromEvent(
        evt({ key: 'Enter', code: 'Enter', metaKey: true, shiftKey: true })
      )
    ).toBe('meta+shift+enter');
  });

  it('lowercases letter keys', () => {
    expect(chordFromEvent(evt({ key: 'K', code: 'KeyK' }))).toBe('k');
  });

  it('returns null for a modifier-only press', () => {
    expect(chordFromEvent(evt({ key: 'Meta', code: 'MetaLeft', metaKey: true }))).toBeNull();
  });

  it('returns null for an unsupported key', () => {
    expect(chordFromEvent(evt({ key: 'F1', code: 'F1' }))).toBeNull();
  });

  it('maps Backquote to the react-hotkeys-hook token "backquote"', () => {
    // The library derives this token from event.code at match time; any other
    // spelling (e.g. "backtick") would register but never fire.
    expect(chordFromEvent(evt({ key: '`', code: 'Backquote', metaKey: true }))).toBe(
      'meta+backquote'
    );
  });
});

describe('formatChord', () => {
  it('renders modifier symbols and named keys', () => {
    expect(formatChord('meta+shift+enter')).toBe('⌘ ⇧ Enter');
    expect(formatChord('shift+slash')).toBe('⇧ /');
  });
});

describe('registry binding ids', () => {
  it('are unique across all single-chord bindings', () => {
    const ids = keyBindings.map((b) => bindingKey(b.action, b.scopes));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('settings shortcut catalog', () => {
  it('only advertises bindings with mounted UI consumers', () => {
    const configurable = getConfigurableKeyBindings({});

    expect(configurable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: Action.CREATE,
          scopes: [Scope.PROJECTS],
        }),
        expect.objectContaining({
          action: Action.SUBMIT_FOLLOW_UP,
          scopes: [Scope.FOLLOW_UP_READY],
        }),
      ])
    );
    expect(configurable).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scopes: [Scope.KANBAN] }),
        expect.objectContaining({ scopes: [Scope.SETTINGS] }),
      ])
    );
  });

  it('does not advertise sequential actions without an execution bridge', () => {
    expect(sequentialBindings.map((binding) => binding.actionId)).toEqual([
      'settings',
      'toggle-changes-mode',
      'toggle-logs-mode',
      'toggle-preview-mode',
      'toggle-left-sidebar',
      'toggle-left-main-panel',
    ]);
  });
});

describe('getKeysFor with overrides', () => {
  it('replaces the default keys with the override chord', () => {
    const id = bindingKey(Action.CREATE, [Scope.KANBAN]);
    expect(getKeysFor(Action.CREATE, Scope.KANBAN)).toEqual(['c']);
    expect(getKeysFor(Action.CREATE, Scope.KANBAN, { [id]: 'n' })).toEqual(['n']);
  });

  it('leaves other bindings untouched', () => {
    const id = bindingKey(Action.CREATE, [Scope.KANBAN]);
    // Overriding the kanban CREATE must not affect the projects CREATE.
    expect(getKeysFor(Action.CREATE, Scope.PROJECTS, { [id]: 'n' })).toEqual([
      'c',
    ]);
  });
});

describe('findChordConflicts', () => {
  it('flags two bindings sharing a chord in an overlapping scope', () => {
    // Rebind kanban CREATE ('c') onto 'k', which kanban NAV_UP already uses.
    const id = bindingKey(Action.CREATE, [Scope.KANBAN]);
    const effective = getEffectiveKeyBindings({ [id]: 'k' });
    const target = effective.find((b) => b.id === id)!;
    const conflicts = findChordConflicts(target, effective);
    expect(conflicts.map((c) => c.action)).toContain(Action.NAV_UP);
  });

  it('flags a conflict against a GLOBAL binding (active in every view)', () => {
    // SHOW_HELP is GLOBAL ('shift+slash'); rebinding a kanban action onto it
    // collides because GLOBAL is always active alongside the view scope.
    const id = bindingKey(Action.DELETE_TASK, [Scope.KANBAN]);
    const effective = getEffectiveKeyBindings({ [id]: 'shift+slash' });
    const target = effective.find((b) => b.id === id)!;
    const conflicts = findChordConflicts(target, effective);
    expect(conflicts.map((c) => c.action)).toContain(Action.SHOW_HELP);
  });

  it('does not flag identical chords in non-overlapping scopes', () => {
    // Default: dialog SUBMIT uses 'enter'; approvals APPROVE_REQUEST uses 'enter'.
    // Different, non-overlapping scopes → not a conflict.
    const effective = getEffectiveKeyBindings({});
    const dialogSubmit = effective.find(
      (b) => b.action === Action.SUBMIT && b.scopes?.includes(Scope.DIALOG)
    )!;
    const conflicts = findChordConflicts(dialogSubmit, effective);
    expect(conflicts.every((c) => c.action !== Action.APPROVE_REQUEST)).toBe(
      true
    );
  });
});
