import { describe, expect, it } from 'vitest';
import type { LocalHistoryScanFolder } from 'shared/types';
import {
  folderImportableKeys,
  localHistorySessionKey,
  resolveFolderWorkspaceId,
} from './importLocalSessions';

const folder = (
  path: string,
  workspaceId: string | null,
  sessions: LocalHistoryScanFolder['sessions']
): LocalHistoryScanFolder => ({
  path,
  name: path.split('/').at(-1) ?? path,
  project_id: workspaceId ? 'project-1' : null,
  project_name: workspaceId ? 'VibeX' : null,
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
});
