import { describe, expect, it } from 'vitest';
import type { DbConversationSummary, GitLogEntry, Tag } from 'shared/types';
import {
  buildAtReferenceGroups,
  commitReferenceUri,
  conversationReferenceUri,
  cycleAtReferenceTab,
  projectReferenceUri,
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
      'project',
      'conversation',
      'commit',
      'instruction',
      'host',
      'action',
    ]);
    expect(groups[0]?.items[0]?.insertText).toBe('[@:App.tsx](src/App.tsx)');
    expect(groups[1]?.items).toEqual([]);
    expect(groups[2]?.items[0]?.insertText).toBe(
      `[Fix auth](${conversationReferenceUri('conv-1')})`
    );
    expect(groups[3]?.items[0]?.insertText).toBe(
      `[${shortCommitSha(commit.sha)}](${commitReferenceUri('repo-1', commit.sha)})`
    );
    expect(groups[4]?.items[0]?.label).toBe('#review-changes');
    expect(groups.find((group) => group.tab === 'host')?.items).toEqual([]);
  });

  it('lists projects by name with their absolute path', () => {
    const groups = buildAtReferenceGroups('vibe', {
      files: [],
      conversations: [],
      commits: [],
      repoId: null,
      instructions: [],
      projects: [
        {
          id: 'proj-1',
          name: 'VibeX',
          path: '/Users/mac/Projects/VibeX',
        },
        {
          id: 'proj-2',
          name: 'Notes',
          path: '/Users/mac/Documents/notes',
        },
      ],
    });
    expect(groups.find((group) => group.tab === 'project')?.items).toEqual([
      {
        id: 'project:proj-1',
        tab: 'project',
        label: 'VibeX',
        detail: '/Users/mac/Projects/VibeX',
        insertText: `[VibeX](${projectReferenceUri(
          'proj-1',
          '/Users/mac/Projects/VibeX'
        )})`,
      },
    ]);
  });

  it('lists Host references in their own tab', () => {
    const groups = buildAtReferenceGroups('lab', {
      files: [],
      conversations: [],
      commits: [],
      repoId: null,
      instructions: [],
      hosts: [
        {
          id: 'lab.sshconfig',
          label: 'Lab',
          detail: 'root@203.0.113.8',
          insertText: '[@:Lab](.vibex/ssh-hosts/lab.sshconfig)',
        },
        {
          id: 'edge.sshconfig',
          label: 'Edge',
          detail: 'deploy@198.51.100.8',
          insertText: '[@:Edge](.vibex/ssh-hosts/edge.sshconfig)',
        },
      ],
    });
    expect(
      groups
        .find((group) => group.tab === 'host')
        ?.items.map((item) => item.label)
    ).toEqual(['Lab']);
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
    expect(cycleAtReferenceTab('file', 1)).toBe('project');
    expect(cycleAtReferenceTab('project', 1)).toBe('conversation');
    expect(cycleAtReferenceTab('instruction', 1)).toBe('host');
    expect(cycleAtReferenceTab('host', 1)).toBe('action');
    expect(cycleAtReferenceTab('action', 1)).toBe('file');
    expect(cycleAtReferenceTab('file', -1)).toBe('action');
    expect(cycleAtReferenceTab('conversation', -1)).toBe('project');
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

  it('lists composer actions on their own tab', () => {
    const groups = buildAtReferenceGroups('', {
      files: [],
      conversations: [],
      commits: [],
      repoId: null,
      instructions: [],
      actions: [
        {
          id: 'plugin:vibex.host-surface/sample-action',
          title: '插入示例说明',
          insertText: '请先阅读示例面板里的说明，再继续。',
        },
      ],
    });
    expect(groups.find((group) => group.tab === 'action')?.items).toEqual([
      {
        id: 'plugin:vibex.host-surface/sample-action',
        tab: 'action',
        label: '插入示例说明',
        insertText: '请先阅读示例面板里的说明，再继续。',
      },
    ]);
  });
});
