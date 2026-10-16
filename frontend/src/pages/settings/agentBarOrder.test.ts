import { describe, expect, it } from 'vitest';
import {
  agentBarContentWidth,
  agentBarPageGap,
  agentBarPageOf,
  agentBarPages,
  defaultAgentIdFromOrder,
  moveAgentInOrder,
  moveAgentToPageEdge,
  nudgeAgentInOrder,
  sortAgentsForBar,
} from './agentBarOrder';

describe('agentBarOrder', () => {
  it('inserts the dragged agent at the drop target and shifts the rest', () => {
    expect(
      moveAgentInOrder(
        ['claude_code', 'codex', 'opencode', 'pi'],
        'pi',
        'codex'
      )
    ).toEqual(['claude_code', 'pi', 'codex', 'opencode']);
  });

  it('returns null when the drop does not change order', () => {
    expect(moveAgentInOrder(['claude_code', 'codex'], 'codex', 'codex')).toBe(
      null
    );
    expect(moveAgentInOrder(['claude_code'], 'missing', 'claude_code')).toBe(
      null
    );
  });

  it('moves the neighbor forward when A is inserted between B and C', () => {
    expect(moveAgentInOrder(['A', 'B', 'C'], 'A', 'B')).toEqual([
      'B',
      'A',
      'C',
    ]);
  });

  it('moves the neighbor backward when C is inserted between A and B', () => {
    expect(moveAgentInOrder(['A', 'B', 'C'], 'C', 'B')).toEqual([
      'A',
      'C',
      'B',
    ]);
  });

  it('nudges an agent one slot earlier or later', () => {
    expect(
      nudgeAgentInOrder(['claude_code', 'codex', 'pi'], 'codex', -1)
    ).toEqual(['codex', 'claude_code', 'pi']);
    expect(
      nudgeAgentInOrder(['claude_code', 'codex', 'pi'], 'codex', 1)
    ).toEqual(['claude_code', 'pi', 'codex']);
    expect(
      nudgeAgentInOrder(['claude_code', 'codex', 'pi'], 'claude_code', -1)
    ).toBe(null);
  });
});

describe('sortAgentsForBar', () => {
  const agents = [
    { agent_id: 'pi', enabled: false },
    { agent_id: 'codex', enabled: true },
    { agent_id: 'claude_code', enabled: true },
    { agent_id: 'grok', enabled: false },
  ];

  it('puts the default Agent first, then other enabled Agents, then disabled Agents', () => {
    expect(
      sortAgentsForBar(agents, 'codex').map((agent) => agent.agent_id)
    ).toEqual(['codex', 'claude_code', 'pi', 'grok']);
  });

  it('falls back to the first enabled Agent when the default is missing', () => {
    expect(
      sortAgentsForBar(agents, 'missing').map((agent) => agent.agent_id)
    ).toEqual(['codex', 'claude_code', 'pi', 'grok']);
  });
});

describe('defaultAgentIdFromOrder', () => {
  it('uses the first icon as the default Agent', () => {
    expect(defaultAgentIdFromOrder(['pi', 'codex'], 'codex')).toBe('pi');
    expect(defaultAgentIdFromOrder([], 'codex')).toBe('codex');
  });
});

describe('agentBarContentWidth', () => {
  it('sums icon widths and the gaps between them, without a trailing tail gap', () => {
    expect(
      agentBarContentWidth(['a', 'b', 'c'], {
        expandedId: 'b',
        labelWidth: 40,
      })
    ).toBe(32 + (32 + 40 + 10) + 32 + 11 * 2);
  });
});

describe('agent bar paging', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const paging = (
    viewportWidth: number,
    expandedId: string | null = null,
    labelWidth = 0
  ) => ({ viewportWidth, expandedId, labelWidth });

  it('keeps everything on one page until the viewport is measured', () => {
    expect(agentBarPages(ids, paging(0))).toEqual([ids]);
  });

  it('enforces a maximum of 10 icons per page even on wide viewports', () => {
    const fourteenIds = [
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
      'l',
      'm',
      'n',
    ];
    expect(agentBarPages(fourteenIds, paging(900))).toEqual([
      fourteenIds.slice(0, 10),
      fourteenIds.slice(10),
    ]);
    expect(agentBarPages(fourteenIds.slice(0, 10), paging(900))).toEqual([
      fourteenIds.slice(0, 10),
    ]);
  });

  it('fills every page it does not need to reserve a name on', () => {
    expect(agentBarPages(ids, paging(400))).toEqual([
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      ['j'],
    ]);
  });

  it('charges only the expanded Agent for its name', () => {
    expect(agentBarPages(ids, paging(400, 'a', 40))).toEqual([
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      ['i', 'j'],
    ]);
    expect(agentBarPages(ids, paging(400, 'j', 40))).toEqual([
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      ['j'],
    ]);
  });

  it('caps the reserved name width', () => {
    expect(agentBarPages(ids, paging(400, 'a', 500))).toEqual(
      agentBarPages(ids, paging(400, 'a', 128))
    );
  });

  it('always seats at least one Agent per page', () => {
    expect(agentBarPages(['a', 'b', 'c'], paging(60))).toEqual([
      ['a'],
      ['b'],
      ['c'],
    ]);
  });

  it('finds the page an Agent lives on', () => {
    const pages = [['a', 'b'], ['c', 'd'], ['e']];
    expect(agentBarPageOf(pages, 'a')).toBe(0);
    expect(agentBarPageOf(pages, 'e')).toBe(2);
    expect(agentBarPageOf(pages, 'missing')).toBeNull();
  });

  it('seats a dragged Agent first on the page it flips forward to', () => {
    expect(moveAgentToPageEdge(ids, 'b', ['d', 'e', 'f'], 'start')).toEqual([
      'a',
      'c',
      'b',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
    ]);
  });

  it('seats a dragged Agent last on the page it flips back to', () => {
    expect(moveAgentToPageEdge(ids, 'i', ['b', 'c', 'd'], 'end')).toEqual([
      'a',
      'b',
      'c',
      'i',
      'd',
      'e',
      'f',
      'g',
      'h',
      'j',
    ]);
  });

  it('appends the dragged Agent when the target page is gone', () => {
    expect(moveAgentToPageEdge(ids, 'a', undefined, 'start')).toEqual([
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'a',
    ]);
  });

  it('does nothing when the Agent is unknown or already seated', () => {
    expect(moveAgentToPageEdge(ids, 'missing', ['d'], 'start')).toBeNull();
    expect(moveAgentToPageEdge(ids, 'a', ['b'], 'start')).toBeNull();
  });
});

describe('agentBarPageGap', () => {
  it('computes equal gaps including the trailing gap to the tail', () => {
    const tenIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    // 500 viewport - 320 items = 180 free space / 10 = 18 gap
    expect(
      agentBarPageGap(tenIds, {
        viewportWidth: 500,
        expandedId: null,
        labelWidth: 0,
      })
    ).toBe(18);
  });

  it('never drops below itemGap', () => {
    const tenIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    expect(
      agentBarPageGap(tenIds, {
        viewportWidth: 350,
        expandedId: null,
        labelWidth: 0,
      })
    ).toBe(11);
  });

  it('caps gap on sparse pages to match maxGap', () => {
    const threeIds = ['a', 'b', 'c'];
    expect(
      agentBarPageGap(
        threeIds,
        { viewportWidth: 500, expandedId: null, labelWidth: 0 },
        18
      )
    ).toBe(18);
  });
});
