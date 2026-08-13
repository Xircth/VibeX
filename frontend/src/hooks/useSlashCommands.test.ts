import { renderHook } from '@testing-library/react';

const { useTauriPatchStream } = vi.hoisted(() => ({
  useTauriPatchStream: vi.fn(),
}));

vi.mock('@/hooks/useTauriPatchStream', () => ({ useTauriPatchStream }));

import { useSlashCommands } from './useSlashCommands';

describe('useSlashCommands', () => {
  it('does not synthesize Agent commands when runtime discovery has not initialized', () => {
    useTauriPatchStream.mockReturnValue({
      data: undefined,
      isConnected: false,
      isInitialized: false,
      error: 'Agent command discovery failed',
    });

    const { result } = renderHook(() =>
      useSlashCommands({ executor: 'codex' } as never)
    );

    expect(result.current.commands).toEqual([]);
    expect(result.current.isInitialized).toBe(false);
    expect(result.current.error).toBe('Agent command discovery failed');
  });

  it('shows every command actually advertised by the Agent runtime', () => {
    useTauriPatchStream.mockReturnValue({
      data: {
        commands: [
          {
            name: 'new-runtime-command',
            description: 'Advertised by the connected Agent',
            kind: 'COMMAND',
          },
        ],
        discovering: false,
        error: null,
      },
      isConnected: true,
      isInitialized: true,
      error: null,
    });

    const { result } = renderHook(() =>
      useSlashCommands({ executor: 'codex' } as never)
    );

    expect(result.current.commands.map((command) => command.name)).toEqual([
      'new-runtime-command',
    ]);
  });
});
