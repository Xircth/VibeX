import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';

const { getClaudeSettings, getClaudeSettingsPath, readFile } = vi.hoisted(
  () => ({
    getClaudeSettings: vi.fn(),
    getClaudeSettingsPath: vi.fn(),
    readFile: vi.fn(),
  })
);

vi.mock('@/lib/api', () => ({
  claudeSettingsApi: { get: getClaudeSettings },
  fileTreeApi: {
    getClaudeSettingsPath,
    readFile,
  },
}));

import { useClaudeSettings } from './useClaudeSettings';

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(() => useClaudeSettings(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

describe('useClaudeSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts an empty native configuration without reading it through a second path', async () => {
    getClaudeSettings.mockResolvedValue({ env: {}, enabled_plugins: {} });

    const { result } = renderSettings();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.settings).toEqual({ env: {}, enabled_plugins: {} });
    expect(getClaudeSettingsPath).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('exposes the native configuration read error instead of returning an empty configuration', async () => {
    getClaudeSettings.mockRejectedValue(new Error('invalid settings JSON'));

    const { result } = renderSettings();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.settings).toBeNull();
    expect(result.current.error).toBe('invalid settings JSON');
    expect(getClaudeSettingsPath).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});
