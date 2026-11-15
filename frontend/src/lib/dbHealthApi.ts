import {
  configuredBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';

export interface DbHealthReport {
  pageCount: number;
  freelistCount: number;
  fragmentationRatio: number;
  tableSizes: Record<string, number>;
  walSizeBytes: number;
  totalDbSizeBytes: number;
  conversationCount: number;
  eventCount: number;
  timelineRowCount: number;
  foldedEventCount: number;
}

export interface DbOptimizeReport {
  walSizeBefore: number;
  walSizeAfter: number;
  bytesReclaimed: number;
}

export interface EventFoldReport {
  conversationsScanned: number;
  eventsBefore: number;
  eventsAfter: number;
  bytesReclaimed: number;
  foldOperations: number;
}

export interface DbHealthApi {
  getHealthReport(): Promise<DbHealthReport>;
  optimizeDatabase(): Promise<DbOptimizeReport>;
  triggerEventFolding(): Promise<EventFoldReport>;
}

export function formatStorageBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (safe < 1024) {
    return `${Math.round(safe)} B`;
  }
  const kb = safe / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function toSafeNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeDbHealthReport(raw: unknown): DbHealthReport {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const rawTables = (rec.tableSizes ?? rec.table_sizes ?? {}) as Record<
    string,
    unknown
  >;
  const tableSizes: Record<string, number> = {};
  if (rawTables && typeof rawTables === 'object') {
    for (const [table, count] of Object.entries(rawTables)) {
      tableSizes[table] = toSafeNumber(count, 0);
    }
  }
  const pageCount = toSafeNumber(rec.pageCount ?? rec.page_count, 0);
  const freelistCount = toSafeNumber(
    rec.freelistCount ?? rec.freelist_count,
    0
  );
  const rawFrag = rec.fragmentationRatio ?? rec.fragmentation_ratio;
  const fragmentationRatio =
    rawFrag !== undefined
      ? toSafeNumber(rawFrag, 0)
      : pageCount > 0
        ? freelistCount / pageCount
        : 0;

  return {
    pageCount,
    freelistCount,
    fragmentationRatio,
    tableSizes,
    walSizeBytes: toSafeNumber(rec.walSizeBytes ?? rec.wal_size_bytes, 0),
    totalDbSizeBytes: toSafeNumber(
      rec.totalDbSizeBytes ?? rec.total_db_size_bytes,
      0
    ),
    conversationCount: toSafeNumber(
      rec.conversationCount ?? rec.conversation_count,
      0
    ),
    eventCount: toSafeNumber(rec.eventCount ?? rec.event_count, 0),
    timelineRowCount: toSafeNumber(
      rec.timelineRowCount ?? rec.timeline_row_count,
      0
    ),
    foldedEventCount: toSafeNumber(
      rec.foldedEventCount ?? rec.folded_event_count,
      0
    ),
  };
}

export function normalizeDbOptimizeReport(raw: unknown): DbOptimizeReport {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const walSizeBefore = toSafeNumber(
    rec.walSizeBefore ?? rec.wal_size_before,
    0
  );
  const walSizeAfter = toSafeNumber(rec.walSizeAfter ?? rec.wal_size_after, 0);
  const bytesReclaimed = toSafeNumber(
    rec.bytesReclaimed ?? rec.bytes_reclaimed,
    Math.max(0, walSizeBefore - walSizeAfter)
  );
  return {
    walSizeBefore,
    walSizeAfter,
    bytesReclaimed,
  };
}

export function normalizeEventFoldReport(raw: unknown): EventFoldReport {
  if (Array.isArray(raw)) {
    return raw.reduce<EventFoldReport>(
      (acc, item) => {
        const part = normalizeEventFoldReport(item);
        return {
          conversationsScanned:
            acc.conversationsScanned + part.conversationsScanned,
          eventsBefore: acc.eventsBefore + part.eventsBefore,
          eventsAfter: acc.eventsAfter + part.eventsAfter,
          bytesReclaimed: acc.bytesReclaimed + part.bytesReclaimed,
          foldOperations: acc.foldOperations + part.foldOperations,
        };
      },
      {
        conversationsScanned: 0,
        eventsBefore: 0,
        eventsAfter: 0,
        bytesReclaimed: 0,
        foldOperations: 0,
      }
    );
  }

  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    conversationsScanned: toSafeNumber(
      rec.conversationsScanned ?? rec.conversations_scanned,
      0
    ),
    eventsBefore: toSafeNumber(rec.eventsBefore ?? rec.events_before, 0),
    eventsAfter: toSafeNumber(rec.eventsAfter ?? rec.events_after, 0),
    bytesReclaimed: toSafeNumber(rec.bytesReclaimed ?? rec.bytes_reclaimed, 0),
    foldOperations: toSafeNumber(rec.foldOperations ?? rec.fold_operations, 0),
  };
}

function isUnavailableDbHealthTransport(transport: BackendTransport): boolean {
  return (
    transport === configuredBackendTransport &&
    transport.environment === 'desktop' &&
    typeof window !== 'undefined' &&
    !('__TAURI_INTERNALS__' in window) &&
    !('__TAURI__' in window)
  );
}

function isUnimplementedDbHealthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /404|not\s*found|unknown\s+command|unimplemented|not\s+implemented|__tauri_internals__|reading\s+'invoke'/i.test(
    msg
  );
}

export function createDbHealthApi(transport: BackendTransport): DbHealthApi {
  const call = <T>(
    command: string,
    args?: Record<string, unknown>
  ): Promise<T> => transport.call(command, args) as Promise<T>;

  return {
    async getHealthReport(): Promise<DbHealthReport> {
      if (isUnavailableDbHealthTransport(transport)) {
        return normalizeDbHealthReport({});
      }
      try {
        const raw = await call<unknown>('db_health_report');
        return normalizeDbHealthReport(raw);
      } catch (error) {
        if (isUnimplementedDbHealthError(error)) {
          return normalizeDbHealthReport({});
        }
        throw error;
      }
    },

    async optimizeDatabase(): Promise<DbOptimizeReport> {
      // Triggers non-blocking PRAGMA wal_checkpoint(TRUNCATE); never full VACUUM.
      const raw = await call<unknown>('db_optimize');
      return normalizeDbOptimizeReport(raw);
    },

    async triggerEventFolding(): Promise<EventFoldReport> {
      const raw = await call<unknown>('trigger_event_folding');
      return normalizeEventFoldReport(raw);
    },
  };
}

export const dbHealthApi = createDbHealthApi(configuredBackendTransport);
