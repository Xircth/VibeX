import { describe, expect, it } from 'vitest';

import { isWorkflowConnectionValid } from './WorkflowStudio';

describe('isWorkflowConnectionValid', () => {
  it('allows an Agent node to connect to its confirmation node', () => {
    expect(
      isWorkflowConnectionValid({
        source: 'start',
        target: 'confirmation:start',
      })
    ).toBe(true);
    expect(
      isWorkflowConnectionValid({
        source: 'confirmation:start',
        target: 'start',
      })
    ).toBe(true);
  });

  it('allows an Agent node to connect to another step or its confirmation', () => {
    expect(
      isWorkflowConnectionValid({ source: 'start', target: 'finish' })
    ).toBe(true);
    expect(
      isWorkflowConnectionValid({
        source: 'confirmation:start',
        target: 'finish',
      })
    ).toBe(true);
  });

  it('rejects a true self-loop', () => {
    expect(
      isWorkflowConnectionValid({ source: 'start', target: 'start' })
    ).toBe(false);
    expect(
      isWorkflowConnectionValid({
        source: 'confirmation:start',
        target: 'confirmation:start',
      })
    ).toBe(false);
  });
});
