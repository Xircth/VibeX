import { describe, expect, it } from 'vitest';
import type { LocalHistoryScanFolder } from 'shared/types';
import {
  filterAndSortLocalHistoryFolders,
  folderImportableKeys,
  formatScanBytes,
  localHistoryImportLogTitle,
  localHistoryImportPercent,
  localHistoryImportTitle,
  localHistorySessionKey,
  parseTimeRangeDays,
  resolveFolderWorkspaceId,
} from './importLocalSessions';

const session = (
  id: string,
  overrides: Partial<LocalHistoryScanFolder['sessions'][number]> = {}
): LocalHistoryScanFolder['sessions'][number] => ({
  agent_id: 'codex',
  external_session_id: id,
  title: id,
  workspace_path: '/Users/mac/Projects/VibeX',
  message_count: 2,
  updated_at: '2026-08-28T00:00:00Z',
  status: 'new',
  ...overrides,
});

const folder = (
  path: string,
  workspaceId: string | null,
  sessions: LocalHistoryScanFolder['sessions'],
  projectId: string | null = workspaceId ? 'project-1' : null
): LocalHistoryScanFolder => ({
  path,
  name: path.split('/').at(-1) ?? path,
  project_id: projectId,
  project_name: projectId ? 'VibeX' : null,
  workspace_id: workspaceId,
  sessions,
});

describe('importLocalSessions', () => {
  it('builds stable session keys and skips already imported rows', () => {
    const scanned = folder('/Users/mac/Projects/VibeX', 'ws-1', [
      {
        agent_id: 'codex',
        external_session_id: 'a',
        title: 'New',
        workspace_path: '/Users/mac/Projects/VibeX',
        message_count: 4,
        updated_at: null,
        status: 'new',
      },
      {
        agent_id: 'codex',
        external_session_id: 'b',
        title: 'Old',
        workspace_path: '/Users/mac/Projects/VibeX',
        message_count: 2,
        updated_at: null,
        status: 'imported',
      },
    ]);

    expect(localHistorySessionKey(scanned.sessions[0])).toBe('codex:a');
    expect(folderImportableKeys(scanned)).toEqual(['codex:a']);
  });

  it('uses only a matched workspace or an explicit destination', () => {
    const matched = folder('/Users/mac/Projects/VibeX', 'ws-matched', []);
    const unmatched = folder('/tmp/scratch', null, []);

    expect(resolveFolderWorkspaceId(matched, undefined)).toBe('ws-matched');
    expect(resolveFolderWorkspaceId(unmatched, 'ws-override')).toBe(
      'ws-override'
    );
    expect(resolveFolderWorkspaceId(unmatched, undefined)).toBeNull();
  });

  it('treats the current session as in-flight until it finishes', () => {
    expect(
      localHistoryImportPercent({
        current: 1,
        total: 1,
        phase: 'loading',
      })
    ).toBe(50);
    expect(
      localHistoryImportPercent({
        current: 1,
        total: 4,
        phase: 'loading',
      })
    ).toBe(13);
    expect(
      localHistoryImportPercent({
        current: 2,
        total: 4,
        phase: 'importing',
      })
    ).toBe(38);
    expect(
      localHistoryImportPercent({
        current: 2,
        total: 4,
        phase: 'imported',
      })
    ).toBe(50);
    expect(
      localHistoryImportPercent({
        current: 4,
        total: 4,
        phase: 'skipped',
      })
    ).toBe(100);
  });

  it('prefers the live title, then the scanned title', () => {
    const sessions = [
      {
        external_session_id: 'codex-1',
        title: 'Scanned title',
      },
    ];
    expect(
      localHistoryImportTitle(
        { title: 'Live title', external_session_id: 'codex-1' },
        sessions,
        'Untitled'
      )
    ).toBe('Live title');
    expect(
      localHistoryImportTitle(
        { title: null, external_session_id: 'codex-1' },
        sessions,
        'Untitled'
      )
    ).toBe('Scanned title');
    expect(
      localHistoryImportTitle(
        { title: null, external_session_id: 'missing' },
        sessions,
        'Untitled'
      )
    ).toBe('Untitled');
  });

  it('falls back to untitled for log lines without a title', () => {
    expect(
      localHistoryImportLogTitle(
        { title: '  Named  ', external_session_id: 'a' },
        'Untitled'
      )
    ).toBe('Named');
    expect(
      localHistoryImportLogTitle(
        { title: null, external_session_id: 'a' },
        'Untitled'
      )
    ).toBe('Untitled');
  });

  it('formats scanned byte totals for the live scan status', () => {
    expect(formatScanBytes(0)).toBe('0 B');
    expect(formatScanBytes(512)).toBe('512 B');
    expect(formatScanBytes(2048)).toBe('2.0 KB');
    expect(formatScanBytes(1048576)).toBe('1.0 MB');
  });

  it('treats blank or invalid time range as unlimited', () => {
    expect(parseTimeRangeDays('')).toBeNull();
    expect(parseTimeRangeDays('  ')).toBeNull();
    expect(parseTimeRangeDays('0')).toBeNull();
    expect(parseTimeRangeDays('abc')).toBeNull();
    expect(parseTimeRangeDays('7')).toBe(7);
    expect(parseTimeRangeDays('30')).toBe(30);
  });

  it('filters by recency, keeps undated sessions, and scopes to existing VibeX projects', () => {
    const now = new Date('2026-09-02T00:00:00Z');
    const currentRoot = folder('/Users/mac/Projects/VibeX', 'ws-root', [
      session('recent'),
      session('old', { updated_at: '2026-01-01T00:00:00Z' }),
      session('undated', { updated_at: null }),
    ]);
    const currentWorktree = folder(
      '/Users/mac/Projects/VibeX/.worktrees/feature',
      'ws-tree',
      [session('worktree')]
    );
    const otherProject = folder(
      '/Users/mac/Projects/Other',
      'ws-other',
      [session('other')],
      'project-2'
    );
    const unmatched = folder('/tmp/scratch', null, [session('loose')]);

    const existing = filterAndSortLocalHistoryFolders({
      folders: [otherProject, unmatched, currentWorktree, currentRoot],
      query: '',
      onlyImportable: true,
      timeRangeDays: 14,
      scanScope: 'existing',
      currentProjectId: 'project-1',
      now,
    });

    expect(existing.map((item) => item.path)).toEqual([
      '/Users/mac/Projects/VibeX',
      '/Users/mac/Projects/VibeX/.worktrees/feature',
      '/Users/mac/Projects/Other',
    ]);
    expect(
      existing[0]?.sessions.map((item) => item.external_session_id)
    ).toEqual(['recent', 'undated']);

    const global = filterAndSortLocalHistoryFolders({
      folders: [otherProject, unmatched, currentWorktree, currentRoot],
      query: '',
      onlyImportable: true,
      timeRangeDays: null,
      scanScope: 'global',
      currentProjectId: 'project-1',
      now,
    });

    expect(global.map((item) => item.path)).toEqual([
      '/Users/mac/Projects/VibeX',
      '/Users/mac/Projects/VibeX/.worktrees/feature',
      '/Users/mac/Projects/Other',
      '/tmp/scratch',
    ]);
  });
});
