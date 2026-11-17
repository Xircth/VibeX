import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DbHealthApi, DbHealthReport } from '@/lib/dbHealthApi';
import { DatabaseHealthSection } from './DatabaseHealthSection';

const FRAGMENTED_REPORT: DbHealthReport = {
  pageCount: 10000,
  freelistCount: 3500,
  fragmentationRatio: 0.35,
  tableSizes: {
    conversation_events: 85000,
    conversation_timeline_rows: 12000,
    conversations: 320,
  },
  walSizeBytes: 64 * 1024 * 1024, // 64.0 MB
  totalDbSizeBytes: 256 * 1024 * 1024, // 256.0 MB
  conversationCount: 320,
  eventCount: 100000,
  timelineRowCount: 12000,
  foldedEventCount: 42000,
};

const HEALTHY_REPORT: DbHealthReport = {
  ...FRAGMENTED_REPORT,
  freelistCount: 800,
  fragmentationRatio: 0.08,
  walSizeBytes: 2 * 1024 * 1024, // 2.0 MB
  eventCount: 68000,
  foldedEventCount: 50000,
};

describe('DatabaseHealthSection', () => {
  it('displays DB storage metrics with tabular-nums, fragmentation advisory > 30%, non-blocking WAL optimize, and event folding', async () => {
    let current = FRAGMENTED_REPORT;
    const api: DbHealthApi = {
      getHealthReport: vi.fn(async () => current),
      optimizeDatabase: vi.fn(async () => {
        current = HEALTHY_REPORT;
        return {
          walSizeBefore: 64 * 1024 * 1024,
          walSizeAfter: 2 * 1024 * 1024,
          bytesReclaimed: 62 * 1024 * 1024,
        };
      }),
      triggerEventFolding: vi.fn(async () => {
        current = {
          ...current,
          foldedEventCount: 55000,
          eventCount: 63000,
        };
        return {
          conversationsScanned: 48,
          eventsBefore: 68000,
          eventsAfter: 63000,
          bytesReclaimed: 8 * 1024 * 1024,
          foldOperations: 120,
        };
      }),
    };

    render(<DatabaseHealthSection api={api} />);

    const totalSizeEl = await screen.findByTestId('db-total-size-stat');
    expect(totalSizeEl).toHaveClass('tabular-nums');
    expect(totalSizeEl).toHaveTextContent('256.0 MB');

    const walSizeEl = screen.getByTestId('db-wal-size-stat');
    expect(walSizeEl).toHaveClass('tabular-nums');
    expect(walSizeEl).toHaveTextContent('64.0 MB');

    const fragEl = screen.getByTestId('db-fragmentation-stat');
    expect(fragEl).toHaveClass('tabular-nums');
    expect(fragEl).toHaveTextContent('35.0%');
    expect(screen.getByTestId('db-fragmentation-advisory')).toBeInTheDocument();

    const foldedStatEl = screen.getByTestId('db-folded-events-stat');
    expect(foldedStatEl).toHaveClass('tabular-nums');
    expect(foldedStatEl).toHaveTextContent('42,000 / 100,000');

    expect(screen.getByTestId('database-health-section')).toHaveClass(
      'settings-row'
    );

    const tableSizesEl = screen.getByTestId('db-table-sizes');
    expect(tableSizesEl).toHaveTextContent('conversation_events');
    expect(tableSizesEl).toHaveClass('max-h-56', 'overflow-y-auto');

    // Optimize Database -> PRAGMA wal_checkpoint(TRUNCATE)
    fireEvent.click(screen.getByTestId('db-optimize-btn'));
    const optResult = await screen.findByTestId('db-optimize-result');
    expect(api.optimizeDatabase).toHaveBeenCalledTimes(1);
    expect(optResult).toHaveTextContent('62.0 MB');

    // Fragmentation advisory clears after refreshed report drops to 8.0%
    await waitFor(() => {
      expect(screen.getByTestId('db-fragmentation-stat')).toHaveTextContent(
        '8.0%'
      );
    });
    expect(screen.queryByTestId('db-fragmentation-advisory')).toBeNull();

    // Trigger Event Folding
    fireEvent.click(screen.getByTestId('db-fold-events-btn'));
    const foldBanner = await screen.findByTestId('db-fold-result');
    expect(api.triggerEventFolding).toHaveBeenCalledTimes(1);
    expect(foldBanner).toHaveTextContent('120');
    expect(foldBanner).toHaveTextContent('48');
    expect(foldBanner).toHaveTextContent('8.0 MB');
  });
});
