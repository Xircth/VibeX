import { describe, expect, it } from 'vitest';
import { type SlashCommandDescription } from 'shared/types';
import type { OfficePluginCatalog } from 'shared/types';
import { DOLLAR_COMMANDS } from '@/lib/dollarCommands';
import type { SearchResultItem } from '@/lib/searchTagsAndFiles';
import {
  formatSessionComposerCommand,
  getSessionComposerStructuredTokenSegments,
  insertPreviewElementToken,
} from './sessionComposerStructuredTokens';
import {
  getTextareaTypeaheadState,
  replaceTextareaTypeaheadRange,
} from './sessionComposerTypeahead';
import {
  dollarCommandsToTypeaheadOptions,
  referenceResultsToTypeaheadOptions,
  rootEntriesToFileReferenceOptions,
  searchResultToTypeaheadOption,
  slashCommandsToTypeaheadOptions,
  pluginActionsToTypeaheadOptions,
} from './sessionComposerTypeaheadOptions';

describe('session composer textarea typeahead', () => {
  it.each([
    ['/', 'run /com', '/', 'com'],
    ['$', 'use $impe', '$', 'impe'],
    ['@', 'open @src/App', '@', 'src/App'],
    ['#', 'apply #review', '#', 'review'],
  ])(
    'matches %s triggers before the textarea caret',
    (_label, value, trigger, query) => {
      const state = getTextareaTypeaheadState(value, value.length);

      expect(state?.trigger).toBe(trigger);
      expect(state?.match.matchingString).toBe(query);
    }
  );

  it('does not match completed trigger text after whitespace', () => {
    expect(getTextareaTypeaheadState('use $plan now', 13)).toBeNull();
  });

  it.each(['调用 !', '调用 ！'])(
    'opens plugin actions for a space followed by %s',
    (value) => {
      const state = getTextareaTypeaheadState(value, value.length);

      expect(state?.trigger).toBe('!');
      expect(state?.match.matchingString).toBe('');
      expect(state?.match.replaceableString).toBe(value.slice(-1));
    }
  );

  it.each(['!', '！', '调用!', '调用！'])(
    'does not open plugin actions without a preceding space: %s',
    (value) => {
      expect(getTextareaTypeaheadState(value, value.length)).toBeNull();
    }
  );

  it('supports filtering after the plugin action trigger', () => {
    const value = '请 ！PPT';
    const state = getTextareaTypeaheadState(value, value.length);

    expect(state?.trigger).toBe('!');
    expect(state?.match.matchingString).toBe('PPT');
    expect(state?.match.replaceableString).toBe('！PPT');
  });

  it('does not match @ triggers inside preview element tokens', () => {
    const value = insertPreviewElementToken({
      value: 'Fix',
      selectionStart: 3,
      selectionEnd: 3,
      componentName: 'GenerateButton',
      filePath: 'src/App.tsx:12:3',
      fullMarkdown: 'From preview click:\n- DOM: button',
    }).value;
    const segments = getSessionComposerStructuredTokenSegments(value);

    expect(
      getTextareaTypeaheadState(value, value.trimEnd().length, segments)
    ).toBeNull();
  });

  it('replaces only the active trigger range', () => {
    const value = 'please use $pla tomorrow';
    const state = getTextareaTypeaheadState(value, 'please use $pla'.length);

    expect(state).not.toBeNull();

    const next = replaceTextareaTypeaheadRange(value, state!.match, '$plan');

    expect(next.value).toBe('please use $plan tomorrow');
    expect(next.caretOffset).toBe('please use $plan'.length);
  });
});

describe('session composer typeahead option derivation', () => {
  it('maps only ready plugin actions into prompt-backed command tokens', () => {
    const catalog = {
      plugin: {
        id: 'vibex.office',
        name: 'Office',
        version: '2.0.0',
        membership: 'builtin',
      },
      actions: [
        {
          pluginId: 'vibex.office',
          actionId: 'create-presentation',
          label: '创建 PPT',
          requiredSkills: ['office-pptx'],
          requiredTools: ['officecli'],
          promptBlocks: [
            {
              type: 'text',
              text: '澄清受众与目标后，创建新的 PPTX 并验证输出。',
            },
          ],
          artifactIntent: null,
        },
      ],
      readiness: {
        enabled: true,
        dependency: {
          id: 'officecli',
          status: 'ready',
          version: '1.0.0',
          error: null,
        },
        skills: [
          {
            id: 'office-pptx',
            status: 'ready',
            version: null,
            error: null,
          },
        ],
        providers: [],
        overall: 'ready',
      },
    } satisfies OfficePluginCatalog;

    expect(
      pluginActionsToTypeaheadOptions(catalog, 'PPT', new Set(['office-pptx']))
    ).toEqual([
      {
        key: 'plugin-vibex.office-create-presentation',
        label: '!创建 PPT',
        description: '澄清受众与目标后，创建新的 PPTX 并验证输出。',
        insertText: `${formatSessionComposerCommand({
          type: '!',
          key: 'vibex.office/create-presentation|创建 PPT',
          value: '',
        })}澄清受众与目标后，创建新的 PPTX 并验证输出。`,
      },
    ]);

    expect(
      pluginActionsToTypeaheadOptions(
        {
          ...catalog,
          readiness: { ...catalog.readiness, enabled: false },
        },
        '',
        new Set(['office-pptx'])
      )
    ).toEqual([]);

    expect(pluginActionsToTypeaheadOptions(catalog, '', new Set())).toEqual([]);
  });

  it('filters slash commands and keeps commands before skills', () => {
    const commands: SlashCommandDescription[] = [
      {
        name: 'review-skill',
        description: 'Review through skill',
        kind: 'SKILL',
      },
      {
        name: 'review',
        description: 'Review changes',
        kind: 'COMMAND',
      },
      {
        name: 'config',
        description: 'Configure runtime',
        kind: 'COMMAND',
      },
    ];

    const options = slashCommandsToTypeaheadOptions(
      commands,
      'review',
      'codex' as const
    );

    expect(options.map((option) => option.insertText)).toEqual([
      formatSessionComposerCommand({
        type: '/',
        key: 'review',
        value: '/review',
      }),
      formatSessionComposerCommand({
        type: '/',
        key: 'review-skill',
        value: '/review-skill',
      }),
    ]);
    expect(options[0]).toMatchObject({
      key: 'slash-review',
      label: '/Review',
      description: 'Review code with optional instructions',
    });
  });

  it('maps dollar commands through the same menu option shape', () => {
    const options = dollarCommandsToTypeaheadOptions(
      [
        { name: 'plan', description: 'Plan work' },
        { name: 'ralph', description: 'Completion loop' },
      ],
      'pla'
    );

    expect(options).toEqual([
      {
        key: 'dollar-plan',
        label: '$plan',
        description: 'Plan work',
        insertText: formatSessionComposerCommand({
          type: '$',
          key: 'plan',
          value: '$plan',
        }),
      },
    ]);
  });

  it('includes the built-in Codex image generation skill in dollar command options', () => {
    const options = dollarCommandsToTypeaheadOptions(DOLLAR_COMMANDS, 'imageg');

    expect(options).toContainEqual({
      key: 'dollar-imagegen',
      label: '$imagegen',
      description: expect.any(String),
      insertText: formatSessionComposerCommand({
        type: '$',
        key: 'imagegen',
        value: '$imagegen',
      }),
    });
  });

  it('normalizes tag and file search results into insertable options', () => {
    const tagResult = {
      type: 'tag',
      tag: {
        id: 'tag-1',
        tag_name: 'review',
        content: null,
        created_at: '',
        updated_at: '',
      },
    } as unknown as SearchResultItem;
    const fileResult: SearchResultItem = {
      type: 'file',
      file: {
        path: 'src/App.tsx',
        name: 'App.tsx',
        is_file: true,
        match_type: 'FullPath',
        score: BigInt(0),
      },
    };

    expect(searchResultToTypeaheadOption(tagResult)).toEqual({
      key: 'tag-tag-1',
      label: '#review',
      description: undefined,
      insertText: formatSessionComposerCommand({
        type: '#',
        key: 'review',
        value: '#review',
      }),
    });
    expect(searchResultToTypeaheadOption(fileResult)).toEqual({
      key: 'file-src/App.tsx',
      label: 'App.tsx',
      description: 'src/App.tsx',
      insertText: formatSessionComposerCommand({
        type: '@',
        key: 'App.tsx',
        value: 'src/App.tsx',
      }),
    });
  });

  it('derives limited root file-reference options with directories first', () => {
    const options = rootEntriesToFileReferenceOptions({
      directories: Array.from({ length: 8 }, (_, index) => `dir-${index}`),
      files: Array.from({ length: 8 }, (_, index) => `file-${index}.ts`),
    });

    expect(options).toHaveLength(10);
    expect(options.slice(0, 8).map((option) => option.insertText)).toEqual(
      Array.from({ length: 8 }, (_, index) =>
        formatSessionComposerCommand({
          type: '@',
          key: `dir-${index}`,
          value: `dir-${index}`,
        })
      )
    );
    expect(options[8].insertText).toBe(
      formatSessionComposerCommand({
        type: '@',
        key: 'file-0.ts',
        value: 'file-0.ts',
      })
    );
    expect(options[9].insertText).toBe(
      formatSessionComposerCommand({
        type: '@',
        key: 'file-1.ts',
        value: 'file-1.ts',
      })
    );
  });

  it('filters mixed reference results by trigger', () => {
    const results: SearchResultItem[] = [
      {
        type: 'tag',
        tag: {
          id: 'tag-1',
          tag_name: 'review',
          content: 'Review current diff',
          created_at: '',
          updated_at: '',
        },
      },
      {
        type: 'file',
        file: {
          path: 'src/App.tsx',
          name: 'App.tsx',
          is_file: true,
          match_type: 'FullPath',
          score: BigInt(0),
        },
      },
    ];

    expect(
      referenceResultsToTypeaheadOptions('#', results).map(
        (option) => option.insertText
      )
    ).toEqual([
      formatSessionComposerCommand({
        type: '#',
        key: 'review',
        value: '#review',
      }),
    ]);
    expect(
      referenceResultsToTypeaheadOptions('@', results).map(
        (option) => option.insertText
      )
    ).toEqual([
      formatSessionComposerCommand({
        type: '@',
        key: 'App.tsx',
        value: 'src/App.tsx',
      }),
    ]);
  });
});
