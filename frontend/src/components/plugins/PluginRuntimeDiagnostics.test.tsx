import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BackendTransportProvider } from '@/lib/transport';
import { renderWithQueryClient } from '@/test/QueryClientHarness';

import { PluginRuntimeDiagnostics } from './PluginRuntimeDiagnostics';

type Diagnostics = {
  workerExpected: boolean;
  workerRunning: boolean;
  generation: number | null;
  missingRuntimes: string[];
  recentCrashes: { message: string; atUnixMs: number }[];
};

const HEALTHY: Diagnostics = {
  workerExpected: true,
  workerRunning: true,
  generation: 7,
  missingRuntimes: [],
  recentCrashes: [],
};

function renderPanel(
  diagnostics: Partial<Diagnostics>,
  lines: { seq: number; stream: string; text: string; atUnixMs: number }[] = []
) {
  const call = vi.fn(async (command: string) => {
    if (command === 'plugin_control_diagnostics') {
      return { ...HEALTHY, ...diagnostics };
    }
    if (command === 'plugin_control_logs') {
      return { lines: lines.map((line) => ({ ...line, pluginId: 'acme.x' })) };
    }
    throw new Error(`unexpected ${command}`);
  });
  renderWithQueryClient(
    <BackendTransportProvider transport={{ environment: 'desktop', call }}>
      <PluginRuntimeDiagnostics pluginId="acme.x" />
    </BackendTransportProvider>
  );
  return call;
}

describe('PluginRuntimeDiagnostics', () => {
  it('reports a live Worker with its serving generation', async () => {
    renderPanel({});
    expect(await screen.findByText('运行中')).toBeInTheDocument();
    expect(screen.getByText('第 7 代')).toBeInTheDocument();
  });

  it('separates a Worker that should be up from one that was never declared', async () => {
    renderPanel({ workerRunning: false, generation: null });
    expect(await screen.findByText('未运行')).toBeInTheDocument();
  });

  it('says nothing is wrong when the package declares no Worker', async () => {
    renderPanel({
      workerExpected: false,
      workerRunning: false,
      generation: null,
    });
    expect(await screen.findByText('未声明')).toBeInTheDocument();
    expect(screen.queryByText('未运行')).not.toBeInTheDocument();
  });

  it('explains an enabled plugin whose runtime is missing', async () => {
    renderPanel({ missingRuntimes: ['cef', 'python'] });
    expect(
      await screen.findByText(/缺少未安装的运行时：cef、python/)
    ).toBeInTheDocument();
  });

  it('shows the most recent crash first', async () => {
    renderPanel({
      recentCrashes: [
        { message: 'older', atUnixMs: 1_000 },
        { message: 'newer', atUnixMs: 2_000 },
      ],
    });
    const crashes = await screen.findAllByText(/older|newer/);
    expect(crashes[0]).toHaveTextContent('newer');
  });

  it('does not fetch logs until the user asks for them', async () => {
    const user = userEvent.setup();
    const call = renderPanel({}, [
      { seq: 1, stream: 'stderr', text: 'boom', atUnixMs: 1_000 },
    ]);

    await screen.findByText('运行中');
    expect(call).not.toHaveBeenCalledWith(
      'plugin_control_logs',
      expect.anything()
    );

    await user.click(screen.getByRole('button', { name: '查看日志' }));
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });
});
