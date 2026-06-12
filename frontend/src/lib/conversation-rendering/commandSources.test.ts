import { describe, expect, it } from 'vitest';
import {
  agentAvailableCommandsToSlashCommands,
  localSkillsToDollarCommands,
  localSkillsToSlashCommands,
  mergeComposerSlashCommands,
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
      },
      {
        name: 'review',
        description: undefined,
        kind: 'COMMAND',
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
      },
    ]);
    expect(localSkillsToDollarCommands(skills)).toEqual([
      {
        name: 'impeccable',
        description: 'Polish UI',
      },
    ]);
  });

  it('merges catalog, runtime, and skill commands in source priority order', () => {
    expect(
      mergeComposerSlashCommands({
        catalogCommands: [{ name: 'review', description: 'Built in' }],
        runtimeCommands: [
          { name: '/review', description: 'Runtime override' },
          { name: '/compact', description: 'Runtime compact' },
        ],
        skillCommands: [{ name: 'impeccable', kind: 'SKILL' }],
      })
    ).toEqual([
      { name: 'review', description: 'Runtime override' },
      { name: 'compact', description: 'Runtime compact' },
      { name: 'impeccable', kind: 'SKILL' },
    ]);
  });
});
