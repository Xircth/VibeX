import { describe, expect, it } from 'vitest';

import {
  appendChildConversationStack,
  popChildConversationStack,
} from './childConversationStack';

describe('childConversationStack', () => {
  it('pushes a child conversation and ignores blanks or the current top', () => {
    expect(appendChildConversationStack([], 'child-1')).toEqual(['child-1']);
    expect(appendChildConversationStack(['child-1'], 'child-1')).toEqual([
      'child-1',
    ]);
    expect(appendChildConversationStack(['child-1'], ' child-2 ')).toEqual([
      'child-1',
      'child-2',
    ]);
    expect(appendChildConversationStack(['child-1'], '   ')).toEqual([
      'child-1',
    ]);
  });

  it('pops the top overlay and leaves an empty stack alone', () => {
    expect(popChildConversationStack(['child-1', 'child-2'])).toEqual([
      'child-1',
    ]);
    expect(popChildConversationStack([])).toEqual([]);
  });
});
