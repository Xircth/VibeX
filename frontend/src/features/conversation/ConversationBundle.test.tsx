import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationBundlePanel } from './ConversationBundle';

const { exportMock, importMock } = vi.hoisted(() => ({
  exportMock: vi.fn(),
  importMock: vi.fn(),
}));

vi.mock('./conversationApi', () => ({
  conversationApi: {
    export: exportMock,
    import: importMock,
  },
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe('ConversationBundlePanel', () => {
  it('exports and displays a portable conversation bundle', async () => {
    exportMock.mockResolvedValue({
      conversationId: 'conversation-1',
      bundle: {
        manifest: {
          bundle_version: 'v1',
          export_app_version: '0.1.0',
          exported_at: '2026-06-14T00:00:00.000Z',
          source_platform: 'test',
          conversation_ids: ['conversation-1'],
          projection_version: 1,
          checksums: [],
        },
        conversations_json: [],
        bindings_json: [],
        turns_json: [],
        events_jsonl: '',
        tool_calls_json: [],
        file_changes_json: [],
        permissions_json: [],
        terminals_json: [],
        checkpoints_json: [],
      },
    });

    render(<ConversationBundlePanel />);

    fireEvent.change(screen.getByPlaceholderText('会话 ID'), {
      target: { value: 'conversation-1' },
    });
    fireEvent.click(screen.getByText('导出会话包'));

    await waitFor(() =>
      expect(exportMock).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        destinationPath: null,
      })
    );
    expect(
      (screen.getByPlaceholderText(/导出的会话包/) as HTMLTextAreaElement).value
    ).toContain('"bundle_version": "v1"');
  });
});
