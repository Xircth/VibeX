import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bootstrapInstallation: vi.fn(),
  toastWarning: vi.fn(),
  updateAndSaveConfig: vi.fn(),
}));

vi.mock('@/components/ConfigProvider', () => ({
  UserSystemProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useUserSystem: () => ({
    config: {
      disclaimer_acknowledged: true,
      onboarding_acknowledged: true,
      show_release_notes: false,
      crash_reports_enabled: false,
    },
    updateAndSaveConfig: mocks.updateAndSaveConfig,
  }),
}));

vi.mock('@/components/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.mock('@/contexts/SearchContext', () => ({
  SearchProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock('@/contexts/ProjectContext', () => ({
  ProjectProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock('react-hotkeys-hook', () => ({
  HotkeysProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock('./contexts/ClickedElementsProvider', () => ({
  ClickedElementsProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock('@/components/AppErrorBoundary', () => ({
  AppErrorBoundary: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock('@/components/layout/ProjectWindowManager', () => ({
  ProjectWindowManager: () => null,
}));

vi.mock('@/components/layout/TrayBadgeSync', () => ({
  TrayBadgeSync: () => null,
}));

vi.mock('@/components/desktop-toast/DesktopToastWindow', () => ({
  DesktopToastWindow: () => null,
}));

vi.mock('@/components/layout/ProjectRail', () => ({
  ProjectRail: () => null,
}));

vi.mock('@/components/ui/sonner', () => ({
  Toaster: () => null,
}));

vi.mock('@/features/agents/useAgentWorkbench', () => ({
  AgentWorkbenchProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock('@/hooks/usePreviousPath', () => ({
  usePreviousPath: () => undefined,
}));

vi.mock('@/hooks/useUiPreferencesScratch', () => ({
  useUiPreferencesScratch: () => undefined,
}));

vi.mock('@/useLegacyDesignBodyClass', () => ({
  useLegacyDesignBodyClass: () => undefined,
}));

vi.mock('@/MainAppRoutes', async () => {
  const { useLocation } =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );

  return {
    MainAppRoutes: () => {
      const location = useLocation();
      return <output data-testid="route-path">{location.pathname}</output>;
    },
  };
});

vi.mock('@/lib/api', () => ({
  agentSettingsApi: {
    bootstrapInstallation: mocks.bootstrapInstallation,
  },
  configApi: {},
}));

vi.mock('@/lib/api/crashReports', () => ({
  crashReportsApi: { list: vi.fn() },
}));

vi.mock('@/lib/tauriApi', () => ({
  tauriListen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock('@/appMaintenancePlan', () => ({
  getLocalDependencyUpdatePromptTools: () => [],
  shouldShowAppUpdateToast: () => false,
  shouldStartSystemMaintenance: () => false,
}));

vi.mock('@/appRouteMode', () => ({
  getAppRouteMode: () => 'main',
}));

vi.mock('@/mainWindowCloseBehavior', () => ({
  getSavedMainWindowCloseBehavior: () => null,
  performMainWindowCloseBehavior: vi.fn(),
  saveMainWindowCloseBehavior: vi.fn(),
}));

vi.mock('@/components/dialogs/global/DisclaimerDialog', () => ({
  DisclaimerDialog: { hide: vi.fn(), show: vi.fn() },
}));

vi.mock('@/components/dialogs/global/OnboardingDialog', () => ({
  OnboardingDialog: { hide: vi.fn(), show: vi.fn() },
}));

vi.mock('@/components/dialogs/global/CrashReportDialog', () => ({
  CrashReportDialog: { hide: vi.fn(), show: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    warning: mocks.toastWarning,
  },
}));

import App from './App';

type BootstrapResult = {
  usableAgents: string[];
  failedAcpAgents: string[];
  incompatibleAcpAgents: string[];
  incompatibleRuntimeAgents: string[];
  installedAcpAgents: string[];
  missingRuntimeAgents: string[];
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderApp({ strictMode = false } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
  const app = <App />;

  render(
    <QueryClientProvider client={queryClient}>
      {strictMode ? <StrictMode>{app}</StrictMode> : app}
    </QueryClientProvider>
  );

  return { invalidateQueries };
}

describe('agent installation bootstrap', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/local-projects');
    mocks.bootstrapInstallation.mockReset();
    mocks.toastWarning.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs once and still consumes the result after a StrictMode effect replay', async () => {
    const pending = deferred<BootstrapResult>();
    mocks.bootstrapInstallation.mockReturnValue(pending.promise);
    const { invalidateQueries } = renderApp({ strictMode: true });

    await waitFor(() => {
      expect(mocks.bootstrapInstallation).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      pending.resolve({
        usableAgents: ['codex'],
        installedAcpAgents: ['codex'],
        failedAcpAgents: [],
        incompatibleAcpAgents: [],
        incompatibleRuntimeAgents: [],
        missingRuntimeAgents: [],
      });
      await pending.promise;
    });

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['agent-settings'],
      });
    });
  });

  it('refreshes picker availability without starting capability discovery', async () => {
    mocks.bootstrapInstallation.mockResolvedValue({
      usableAgents: ['codex'],
      installedAcpAgents: ['codex'],
      failedAcpAgents: [],
      incompatibleAcpAgents: [],
      incompatibleRuntimeAgents: [],
      missingRuntimeAgents: [],
    } satisfies BootstrapResult);
    const { invalidateQueries } = renderApp();

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['agent-settings'],
      });
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['agent-capability-catalog', 'codex'],
      })
    );
  });

  it('sends missing runtime setup users to Agent settings from the toast action', async () => {
    mocks.bootstrapInstallation.mockResolvedValue({
      usableAgents: [],
      installedAcpAgents: [],
      failedAcpAgents: [],
      incompatibleAcpAgents: [],
      incompatibleRuntimeAgents: [],
      missingRuntimeAgents: ['codex'],
    } satisfies BootstrapResult);
    renderApp();

    await waitFor(() => {
      expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
    });

    const options = mocks.toastWarning.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    act(() => options.action.onClick());

    expect(await screen.findByTestId('route-path')).toHaveTextContent(
      '/settings/agents'
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
  });

  it('also directs an incompatible local ACP adapter to Agent settings', async () => {
    mocks.bootstrapInstallation.mockResolvedValue({
      usableAgents: [],
      installedAcpAgents: [],
      failedAcpAgents: [],
      incompatibleAcpAgents: ['codex'],
      incompatibleRuntimeAgents: [],
      missingRuntimeAgents: [],
    } satisfies BootstrapResult);
    renderApp();

    await waitFor(() => {
      expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
    });

    const options = mocks.toastWarning.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    act(() => options.action.onClick());

    expect(await screen.findByTestId('route-path')).toHaveTextContent(
      '/settings/agents'
    );
  });

  it('does not warn about optional missing runtimes when one agent is usable', async () => {
    mocks.bootstrapInstallation.mockResolvedValue({
      usableAgents: ['codex'],
      installedAcpAgents: [],
      failedAcpAgents: [],
      incompatibleAcpAgents: [],
      incompatibleRuntimeAgents: [],
      missingRuntimeAgents: ['claude_code', 'opencode'],
    } satisfies BootstrapResult);
    renderApp();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.toastWarning).not.toHaveBeenCalled();
  });

  it('warns when ACP reconciliation fails even if another agent is usable', async () => {
    mocks.bootstrapInstallation.mockResolvedValue({
      usableAgents: ['opencode'],
      installedAcpAgents: [],
      failedAcpAgents: ['codex'],
      incompatibleAcpAgents: [],
      incompatibleRuntimeAgents: [],
      missingRuntimeAgents: ['claude_code'],
    } satisfies BootstrapResult);
    renderApp();

    await waitFor(() => {
      expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
    });
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      expect.stringContaining('Codex'),
      expect.anything()
    );
  });
});
