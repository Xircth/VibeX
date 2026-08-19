import { describe, expect, it } from 'vitest';
import {
  agentAvailableCommandsToSlashCommands,
  localSkillsToDollarCommands,
  localSkillsToSlashCommands,
  mergeComposerSlashCommands,
  pluginComposerSlashContributions,
  pluginInvocationsToSlashCommands,
} from './commandSources';

describe('composer command sources', () => {
  it('normalizes runtime available commands for slash typeahead', () => {
    expect(
      agentAvailableCommandsToSlashCommands([
        { name: '/compact', description: 'Compact context' },
        { name: ' review ', description: null },
        { name: '   ' },
      ])
    ).toEqual([
      {
        name: 'compact',
        description: 'Compact context',
        kind: 'COMMAND',
        sourceKind: 'native',
        sourceId: 'runtime:compact',
      },
      {
        name: 'review',
        description: undefined,
        kind: 'COMMAND',
        sourceKind: 'native',
        sourceId: 'runtime:review',
      },
    ]);
  });

  it('maps local skills into slash and dollar command sources', () => {
    const skills = [
      {
        name: 'impeccable',
        description: 'Polish UI',
        path: 'skills/impeccable/SKILL.md',
        invocation: '$impeccable',
      },
    ];

    expect(localSkillsToSlashCommands(skills)).toEqual([
      {
        name: 'impeccable',
        description: 'Polish UI',
        kind: 'SKILL',
        sourceKind: 'skill',
        sourceId: 'skills/impeccable/SKILL.md',
      },
    ]);
    expect(localSkillsToDollarCommands(skills)).toEqual([
      {
        name: 'impeccable',
        description: 'Polish UI',
      },
    ]);
  });

  it('keeps same-name plugin, skill, and native candidates with structured identity', () => {
    expect(
      mergeComposerSlashCommands({
        catalogCommands: [{ name: 'review', description: 'Built in' }],
        runtimeCommands: [
          {
            name: '/review',
            description: 'Runtime override',
            sourceKind: 'native',
            sourceId: 'runtime:review',
          },
          {
            name: '/compact',
            description: 'Runtime compact',
            sourceKind: 'native',
            sourceId: 'runtime:compact',
          },
        ],
        pluginCommands: [
          {
            name: 'review',
            displayLabel: 'Review workflow',
            sourceKind: 'plugin',
            sourceId: 'dev.vibex.review/review',
          },
        ],
        skillCommands: [
          {
            name: 'review',
            kind: 'SKILL',
            sourceKind: 'skill',
            sourceId: '/skills/review/SKILL.md',
          },
        ],
      })
    ).toEqual([
      {
        name: 'review',
        description: 'Runtime override',
        sourceKind: 'native',
        sourceId: 'runtime:review',
      },
      {
        name: 'compact',
        description: 'Runtime compact',
        sourceKind: 'native',
        sourceId: 'runtime:compact',
      },
      {
        name: 'review',
        displayLabel: 'Review workflow',
        sourceKind: 'plugin',
        sourceId: 'dev.vibex.review/review',
      },
      {
        name: 'review',
        kind: 'SKILL',
        sourceKind: 'skill',
        sourceId: '/skills/review/SKILL.md',
      },
    ]);
  });

  it('maps enabled PluginAction and Plugin Command contributions to slash candidates', () => {
    expect(
      pluginInvocationsToSlashCommands({
        plugins: [
          {
            id: 'dev.vibex.review',
            name: 'Review',
            version: '1.0.0',
            description: null,
            enabled: true,
            builtin: false,
            sourceKind: 'snapshot',
            sourcePath: '/plugins/review',
            formats: ['vibex'],
            skills: [],
            runtimes: [],
            warnings: [],
            invocations: [
              {
                id: 'review',
                label: 'Review',
                prompt: 'Review this.',
                kind: 'action',
              },
            ],
          },
        ],
        runtimes: [],
      })
    ).toMatchObject([
      {
        name: 'review',
        sourceKind: 'plugin',
        sourceId: 'dev.vibex.review/review',
        prompt: 'Review this.',
      },
    ]);
  });

  it('maps composer.slash contributions to plugin slash candidates', () => {
    expect(
      pluginComposerSlashContributions([
        {
          pluginId: 'vibex.office',
          id: 'create-slides',
          kind: 'composer_slash',
          label: 'Create slides',
          generation: 1,
          metadata: {
            command: '/slides',
            description: 'Start a presentation',
            prompt: 'Create a presentation',
          },
        },
      ])
    ).toEqual([
      {
        name: 'slides',
        displayLabel: 'Create slides',
        description: 'Start a presentation',
        kind: 'COMMAND',
        sourceKind: 'plugin',
        sourceId: 'vibex.office/create-slides',
        prompt: 'Create a presentation',
      },
    ]);
  });
});
