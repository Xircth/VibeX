import { describe, expect, it } from 'vitest';
import { filterDollarCommands, mergeDollarCommands } from './dollarCommands';

describe('dollarCommands', () => {
  it('keeps disk skills ahead of static commands and prefers the skill on name collision', () => {
    expect(
      mergeDollarCommands(
        [
          { name: 'plan', description: 'Static plan' },
          { name: 'ralph', description: 'Static ralph' },
        ],
        [{ name: 'plan', description: 'Disk plan skill' }]
      )
    ).toEqual([
      { name: 'plan', description: 'Disk plan skill' },
      { name: 'ralph', description: 'Static ralph' },
    ]);
  });

  it('matches dollar skills by subsequence after the trigger', () => {
    expect(
      filterDollarCommands(
        [
          { name: 'imagegen', description: 'Images' },
          { name: 'plan', description: 'Plan' },
        ],
        '$img'
      ).map((command) => command.name)
    ).toEqual(['imagegen']);
  });
});
