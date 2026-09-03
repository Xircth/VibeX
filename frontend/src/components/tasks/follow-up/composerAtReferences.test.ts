import { describe, expect, it } from 'vitest';
import type { DbConversationSummary, GitLogEntry, Tag } from 'shared/types';
import {
  buildAtReferenceGroups,
  commitReferenceUri,
  conversationReferenceUri,
  cycleAtReferenceTab,
  firstNonEmptyTab,
  isAtReferenceNavigationKey,
  matchAtReferenceTrigger,
  mergeAtReferenceSearch,
  parseCommitReferenceUri,
  parseConversationReferenceUri,
  shortCommitSha,
} from './composerAtReferences';

function conversation(
  overrides: Partial<DbConversationSummary> & { id: string }
): DbConversationSummary {
  return {
    workspace_id: 'ws-1',
    task_id: null,
    title: 'Fix auth',
    title_locked: false,
    status: 'inprogress',
    agent_id: 'codex',
    model: null,
    external_session_id: null,
    message_count: BigInt(2),
    pinned_at: null,
    parent_session_id: null,
    parent_tool_use_id: null,
    delegation_call_id: null,
    created_at: '2026-08-26T00:00:00Z',
    updated_at: '2026-08-26T00:00:00Z',
    ...overrides,
  };
}

const commit: GitLogEntry = {
  sha: 'abcdef1234567890',
  summary: 'Fix token parsing',
  author: 'Ada',
  timestamp: 1,
  refs: [],
};

const tag: Tag = {
  id: 'builtin:review-changes',
  tag_name: 'review-changes',
  content: 'Review the diff.',
  created_at: '',
  updated_at: '',
};

describe('composer @ references', () => {
  it('builds stable tab order with capped counts', () => {
    const groups = buildAtReferenceGroups('', {
      files: [{ path: 'src/App.tsx', name: 'App.tsx' }],
      conversations: [conversation({ id: 'conv-1' })],
      commits: [commit],
      repoId: 'repo-1',
      instructions: [tag],
    });

    expect(groups.map((group) => group.tab)).toEqual([
      'file',
      'conversation',
      'commit',
      'instruction',
    ]);
    expect(groups[0]?.items[0]?.insertText).toBe('[@:App.tsx](src/App.tsx)');
    expect(groups[1]?.items[0]?.insertText).toBe(
      `[Fix auth](${conversationReferenceUri('conv-1')})`
    );
    expect(groups[2]?.items[0]?.insertText).toBe(
      `[${shortCommitSha(commit.sha)}](${commitReferenceUri('repo-1', commit.sha)})`
    );
    expect(groups[3]?.items[0]?.label).toBe('#review-changes');
  });

  it('filters each tab independently and skips the current conversation', () => {
    const groups = buildAtReferenceGroups('auth', {
      files: [
        { path: 'src/auth.ts', name: 'auth.ts' },
        { path: 'src/App.tsx', name: 'App.tsx' },
      ],
      conversations: [
        conversation({ id: 'current', title: 'Current auth' }),
        conversation({ id: 'other', title: 'Fix auth' }),
      ],
      commits: [commit],
      repoId: 'repo-1',
      instructions: [tag],
      currentConversationId: 'current',
    });

    expect(groups.find((group) => group.tab === 'file')?.items).toHaveLength(1);
    expect(
      groups
        .find((group) => group.tab === 'conversation')
        ?.items.map((item) => item.id)
    ).toEqual(['conversation:other']);
    expect(
      groups.find((group) => group.tab === 'instruction')?.items
    ).toHaveLength(0);
  });

  it('keeps commit and file tabs empty without a repo', () => {
    const groups = buildAtReferenceGroups('', {
      files: [{ path: 'src/App.tsx', name: 'App.tsx' }],
      conversations: [conversation({ id: 'conv-1' })],
      commits: [commit],
      repoId: null,
      instructions: [],
    });

    expect(groups.find((group) => group.tab === 'commit')?.items).toEqual([]);
    expect(groups.find((group) => group.tab === 'file')?.items).toHaveLength(1);
  });

  it('prefers the first non-empty tab until one is pinned', () => {
    const groups = buildAtReferenceGroups('', {
      files: [],
      conversations: [conversation({ id: 'conv-1' })],
      commits: [],
      repoId: null,
      instructions: [],
    });
    expect(firstNonEmptyTab(groups)).toBe('conversation');
    expect(firstNonEmptyTab(groups, 'instruction')).toBe('instruction');
  });

  it('round-trips conversation and commit URIs', () => {
    expect(parseConversationReferenceUri(conversationReferenceUri('abc'))).toBe(
      'abc'
    );
    expect(
      parseCommitReferenceUri(commitReferenceUri('repo 1', 'deadbeef'))
    ).toEqual({ repoId: 'repo 1', sha: 'deadbeef' });
  });

  it('matches @ only at a token boundary', () => {
    expect(matchAtReferenceTrigger('@App')?.matchingString).toBe('App');
    expect(matchAtReferenceTrigger('see @App')?.matchingString).toBe('App');
    expect(matchAtReferenceTrigger('user@App')).toBeNull();
  });

  it('cycles tabs left and right', () => {
    expect(cycleAtReferenceTab('file', 1)).toBe('conversation');
    expect(cycleAtReferenceTab('instruction', 1)).toBe('file');
    expect(cycleAtReferenceTab('file', -1)).toBe('instruction');
    expect(cycleAtReferenceTab('conversation', -1)).toBe('file');
  });

  it('keeps the highlighted row when the same query refreshes', () => {
    const groups = buildAtReferenceGroups('', {
      files: [
        { path: 'a.ts', name: 'a.ts' },
        { path: 'b.ts', name: 'b.ts' },
      ],
      conversations: [],
      commits: [],
      repoId: null,
      instructions: [],
    });
    expect(
      mergeAtReferenceSearch({
        query: '',
        groups,
        currentQuery: '',
        currentTab: 'file',
        currentSelectedIndex: 1,
        pinnedTab: 'file',
      })
    ).toEqual({ activeTab: 'file', selectedIndex: 1 });
  });

  it('resets the highlight when the query changes', () => {
    const groups = buildAtReferenceGroups('b', {
      files: [
        { path: 'a.ts', name: 'a.ts' },
        { path: 'b.ts', name: 'b.ts' },
      ],
      conversations: [],
      commits: [],
      repoId: null,
      instructions: [],
    });
    expect(
      mergeAtReferenceSearch({
        query: 'b',
        groups,
        currentQuery: '',
        currentTab: 'file',
        currentSelectedIndex: 1,
        pinnedTab: 'file',
      }).selectedIndex
    ).toBe(0);
  });

  it('treats arrow keys as panel navigation', () => {
    expect(isAtReferenceNavigationKey('ArrowDown')).toBe(true);
    expect(isAtReferenceNavigationKey('ArrowLeft')).toBe(true);
    expect(isAtReferenceNavigationKey('a')).toBe(false);
  });
});
