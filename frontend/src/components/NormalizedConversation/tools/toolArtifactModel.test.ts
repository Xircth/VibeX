import { describe, expect, it } from 'vitest';
import {
  commandExitCode,
  formatFactValue,
  jsonToFacts,
  searchArgumentFacts,
  splitCodeLines,
  stringList,
} from './toolArtifactModel';

describe('toolArtifactModel', () => {
  it('drops a trailing newline from code snippets', () => {
    expect(splitCodeLines('one\ntwo\n')).toEqual(['one', 'two']);
    expect(splitCodeLines('')).toEqual([]);
  });

  it('renders object facts without empty keys', () => {
    expect(
      jsonToFacts({
        query: 'streamdown',
        total: 3,
        empty: '',
        missing: null,
      })
    ).toEqual([
      { key: 'query', value: 'streamdown' },
      { key: 'total', value: '3' },
    ]);
  });

  it('joins primitive arrays and stringifies nested values', () => {
    expect(formatFactValue(['yes', 'no'])).toBe('yes, no');
    expect(formatFactValue({ answer: 'yes' })).toBe('{"answer":"yes"}');
  });

  it('hides the repeated search query from extra arguments', () => {
    expect(
      searchArgumentFacts(
        {
          query: 'session cancel',
          path: 'crates/conversations',
          maxResults: 20,
        },
        'session cancel'
      )
    ).toEqual([
      { key: 'path', value: 'crates/conversations' },
      { key: 'maxResults', value: '20' },
    ]);
  });

  it('maps command exit status to a compact code', () => {
    expect(commandExitCode({ type: 'exit_code', code: 0 })).toEqual({
      code: 0,
      ok: true,
    });
    expect(commandExitCode({ type: 'success', success: false })).toEqual({
      code: 1,
      ok: false,
    });
  });

  it('reads option lists from question arguments', () => {
    expect(stringList(['yes', 'no', ''])).toEqual(['yes', 'no']);
  });
});
