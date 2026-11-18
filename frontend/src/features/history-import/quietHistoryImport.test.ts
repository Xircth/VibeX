import { afterEach, describe, expect, it } from 'vitest';
import {
  QUIET_HISTORY_IMPORT_HOLD_MS,
  armQuietHistoryImport,
  clearQuietHistoryImport,
  noteQuietHistoryImportFinished,
  quietHistoryImportVisible,
  readQuietHistoryImport,
} from './quietHistoryImport';

afterEach(() => {
  sessionStorage.clear();
});

describe('quiet history import', () => {
  it('stays visible while the job runs and for 10 minutes after it finishes', () => {
    const armed = armQuietHistoryImport(1_000);
    expect(readQuietHistoryImport()).toEqual(armed);
    expect(quietHistoryImportVisible(armed, 'running', 50_000)).toBe(true);

    const finished = noteQuietHistoryImportFinished(5_000);
    expect(finished?.completedAt).toBe(5_000);
    expect(noteQuietHistoryImportFinished(9_000)?.completedAt).toBe(5_000);
    expect(
      quietHistoryImportVisible(
        finished,
        'completed',
        5_000 + QUIET_HISTORY_IMPORT_HOLD_MS - 1
      )
    ).toBe(true);
    expect(
      quietHistoryImportVisible(
        finished,
        'completed',
        5_000 + QUIET_HISTORY_IMPORT_HOLD_MS
      )
    ).toBe(false);
  });

  it('hides when nothing was armed', () => {
    expect(quietHistoryImportVisible(null, 'running', 0)).toBe(false);
    clearQuietHistoryImport();
    expect(readQuietHistoryImport()).toBeNull();
  });
});
