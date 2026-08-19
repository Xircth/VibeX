import { describe, expect, it } from 'vitest';
import {
  deleteSessionComposerStructuredToken,
  formatSessionComposerCommand,
  getSessionComposerFileRefs,
  getSessionComposerPluginActionInvocations,
  getSessionComposerStructuredTokenSegments,
  getSessionComposerStructuredTokens,
  insertFileReferenceToken,
  insertPreviewElementToken,
  serializeSessionComposerBackendMessage,
} from './sessionComposerStructuredTokens';

describe('session composer structured commands', () => {
  it('formats file, slash, dollar, tag, and plugin action commands with the explicit command contract', () => {
    expect(
      formatSessionComposerCommand({
        type: '@',
        key: 'design.md',
        value: '/ui/design.md',
      })
    ).toBe('[@:design.md](/ui/design.md)');
    expect(
      formatSessionComposerCommand({
        type: '/',
        key: 'review',
        value: '/review',
      })
    ).toBe('[/:review](/review)');
    expect(
      formatSessionComposerCommand({
        type: '$',
        key: 'plan',
        value: '$plan',
      })
    ).toBe('[$:plan]($plan)');
    expect(
      formatSessionComposerCommand({
        type: '#',
        key: 'bug',
        value: '#bug',
      })
    ).toBe('[#:bug](#bug)');
    expect(
      formatSessionComposerCommand({
        type: '!',
        key: 'vibex.office/create-presentation',
        value: 'Create a presentation',
      })
    ).toBe('[!:vibex.office/create-presentation](Create a presentation)');
  });

  it('escapes command keys and values without exposing escape text in the chip', () => {
    const raw = formatSessionComposerCommand({
      type: '@',
      key: 'Save]Button',
      value:
        'From preview click:\n- Selected start: SaveButton (`src/App.tsx:12:3`)\n- Element source: <button>)',
    });

    expect(raw).toContain('Save\\]Button');
    expect(raw).toContain('<button>\\)');
    expect(getSessionComposerStructuredTokens(raw)).toEqual([
      expect.objectContaining({
        kind: 'element',
        label: 'Save]Button',
        value:
          'From preview click:\n- Selected start: SaveButton (`src/App.tsx:12:3`)\n- Element source: <button>)',
      }),
    ]);
  });

  it('shows only the command name for skill-backed slash tokens', () => {
    const raw = formatSessionComposerCommand({
      type: '/',
      key: 'skill:/Users/mac/.agents/skills/grill-me:grill-me',
      value: '/skill:/Users/mac/.agents/skills/grill-me:grill-me',
    });

    expect(getSessionComposerStructuredTokens(raw)).toEqual([
      expect.objectContaining({
        kind: 'slash',
        label: '/grill-me',
        value: '/skill:/Users/mac/.agents/skills/grill-me:grill-me',
      }),
    ]);
    expect(serializeSessionComposerBackendMessage(raw)).toBe(
      '/skill:/Users/mac/.agents/skills/grill-me:grill-me'
    );
  });

  it('splits composer text into Text and Command segments', () => {
    const fileCommand = formatSessionComposerCommand({
      type: '@',
      key: 'App.tsx',
      value: 'src/App.tsx',
    });
    const slashCommand = formatSessionComposerCommand({
      type: '/',
      key: 'review',
      value: '/review',
    });

    expect(
      getSessionComposerStructuredTokenSegments(
        `Run ${slashCommand} with ${fileCommand} now`
      )
    ).toEqual([
      { kind: 'text', text: 'Run ' },
      {
        kind: 'token',
        start: 'Run '.length,
        end: `Run ${slashCommand}`.length,
        token: {
          kind: 'slash',
          type: '/',
          key: 'review',
          label: '/review',
          value: '/review',
          raw: slashCommand,
        },
      },
      { kind: 'text', text: ' with ' },
      {
        kind: 'token',
        start: `Run ${slashCommand} with `.length,
        end: `Run ${slashCommand} with ${fileCommand}`.length,
        token: {
          kind: 'file',
          type: '@',
          key: 'App.tsx',
          label: 'App.tsx',
          value: 'src/App.tsx',
          raw: fileCommand,
          title: 'src/App.tsx',
        },
      },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('keeps unconfirmed legacy-style commands as plain text segments', () => {
    expect(
      getSessionComposerStructuredTokenSegments('Use $image-m and keep typing')
    ).toEqual([{ kind: 'text', text: 'Use $image-m and keep typing' }]);
  });

  it('serializes backend text with command values instead of chip labels or raw command markup', () => {
    const fileCommand = formatSessionComposerCommand({
      type: '@',
      key: 'App.tsx',
      value: 'src/App.tsx',
    });
    const dollarCommand = formatSessionComposerCommand({
      type: '$',
      key: 'plan',
      value: '$plan',
    });

    expect(
      serializeSessionComposerBackendMessage(
        `Run ${dollarCommand} on ${fileCommand}`
      )
    ).toBe('Run $plan on src/App.tsx');
  });

  it('inserts dropped file references as command objects with fixed spacing', () => {
    expect(
      insertFileReferenceToken({
        value: 'Review  please',
        selectionStart: 7,
        selectionEnd: 7,
        relativePath: 'src/App.tsx',
      })
    ).toEqual({
      value: `Review ${formatSessionComposerCommand({
        type: '@',
        key: 'App.tsx',
        value: 'src/App.tsx',
      })} please`,
      caretOffset: `Review ${formatSessionComposerCommand({
        type: '@',
        key: 'App.tsx',
        value: 'src/App.tsx',
      })} `.length,
    });
  });

  it('extracts workspace file tokens as resource refs including line ranges', () => {
    const value = insertFileReferenceToken({
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      relativePath: 'src/main.rs:10-20',
    }).value;

    expect(getSessionComposerFileRefs(value)).toEqual([
      { path: 'src/main.rs', startLine: 10, endLine: 20 },
    ]);
  });

  it('represents preview elements as command chips and serializes them to full element context', () => {
    const elementContext =
      'From preview click:\n- DOM: button.primary\n- Selected start: SaveButton (`src/App.tsx:12:3`)';
    const next = insertPreviewElementToken({
      value: 'Fix',
      selectionStart: 3,
      selectionEnd: 3,
      componentName: 'SaveButton',
      filePath: 'src/App.tsx:12:3',
      fullMarkdown: elementContext,
    });

    expect(next.value).toContain('[@:SaveButton](');
    expect(next.value).not.toContain('@element:');
    expect(getSessionComposerStructuredTokens(next.value)).toEqual([
      expect.objectContaining({
        kind: 'element',
        label: 'SaveButton',
        value: elementContext,
        title: elementContext,
      }),
    ]);
    expect(serializeSessionComposerBackendMessage(next.value)).toBe(
      `Fix ${elementContext} `
    );
  });

  it('deletes a whole command when backspacing from its fixed trailing space', () => {
    const command = formatSessionComposerCommand({
      type: '@',
      key: 'App.tsx',
      value: 'src/App.tsx',
    });
    const value = `Review ${command} now`;

    expect(
      deleteSessionComposerStructuredToken({
        value,
        selectionStart: `Review ${command}`.length,
        selectionEnd: `Review ${command}`.length,
        direction: 'backward',
      })
    ).toEqual({
      value: 'Review now',
      caretOffset: 'Review '.length,
    });
  });

  it('retains unique PluginAction identities separately from editable prompt text', () => {
    const action = formatSessionComposerCommand({
      type: '!',
      key: 'vibex.office/create-presentation|创建 PPT',
      value: '',
    });
    const message = `${action}Edit this prompt ${action}`;

    expect(getSessionComposerPluginActionInvocations(message)).toEqual([
      {
        pluginId: 'vibex.office',
        actionId: 'create-presentation',
      },
    ]);
    expect(serializeSessionComposerBackendMessage(message)).toBe(
      'Edit this prompt '
    );
  });

  it('does not delete an unconfirmed legacy-style command as a whole token', () => {
    expect(
      deleteSessionComposerStructuredToken({
        value: 'Use $image-m',
        selectionStart: 'Use $image-m'.length,
        selectionEnd: 'Use $image-m'.length,
        direction: 'backward',
      })
    ).toBeNull();
  });
});
