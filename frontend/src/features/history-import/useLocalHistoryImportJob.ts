import { useEffect, useState } from 'react';
import type { LocalHistoryImportJobSnapshot } from 'shared/types';
import { agentsApi } from '@/features/agents/api';
import { backendListen } from '@/lib/backendTransport';

export const LOCAL_HISTORY_IMPORT_PROGRESS_EVENT =
  'local-history-import-progress';

const IDLE_SNAPSHOT: LocalHistoryImportJobSnapshot = {
  status: 'idle',
  progress: null,
  result: null,
  log: [],
};

export function useLocalHistoryImportJob(): LocalHistoryImportJobSnapshot {
  const [snapshot, setSnapshot] =
    useState<LocalHistoryImportJobSnapshot>(IDLE_SNAPSHOT);

  useEffect(() => {
    let disposed = false;
    let unlisten: () => void = () => undefined;
    void agentsApi.localHistoryImportSnapshot().then((next) => {
      if (!disposed) setSnapshot(next);
    });
    void backendListen<LocalHistoryImportJobSnapshot>(
      LOCAL_HISTORY_IMPORT_PROGRESS_EVENT,
      (next) => {
        if (!disposed) setSnapshot(next);
      }
    ).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, []);

  return snapshot;
}
