import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { usePreviousPath } from '@/hooks/usePreviousPath';
import { useUiPreferencesScratch } from '@/hooks/useUiPreferencesScratch';

import { UserSystemProvider, useUserSystem } from '@/components/ConfigProvider';
import { ThemeProvider, useTheme } from '@/components/ThemeProvider';
import { SearchProvider } from '@/contexts/SearchContext';
import { Toaster, toast } from '@/components/ui/toast';
import { ProjectWindowManager } from '@/components/layout/ProjectWindowManager';
import { TrayBadgeSync } from '@/components/layout/TrayBadgeSync';
import { DesktopToastWindow } from '@/components/desktop-toast/DesktopToastWindow';

import { HotkeysProvider } from 'react-hotkeys-hook';

import { ProjectProvider } from '@/contexts/ProjectContext';
import { ThemeMode } from 'shared/types';

import { CrashReportDialog } from '@/components/dialogs/global/CrashReportDialog';
import { crashReportsApi } from '@/lib/api/crashReports';
import { ClickedElementsProvider } from './contexts/ClickedElementsProvider';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { settingsWindowApi } from '@/lib/api';
import { checkAppUpdate } from '@/lib/appUpdate';
import { getStartupPromptStep } from '@/appStartupPrompt';
import { getAppRouteMode } from '@/appRouteMode';
import { useLegacyDesignBodyClass } from '@/useLegacyDesignBodyClass';
import { MainAppRoutes } from '@/MainAppRoutes';
import { AgentWorkbenchProvider } from '@/features/agents/useAgentWorkbench';
import { scheduleIdleWork } from '@/lib/scheduleIdleWork';
import { useBackendTransport } from '@/lib/transport';
import {
  SequenceIndicator,
  SequenceTrackerProvider,
  SHORTCUT_ACTION_EVENT,
  type ShortcutActionEventDetail,
} from '@/keyboard';

const FirstRunExperience = lazy(() =>
  import('@/components/onboarding/FirstRunExperience').then((module) => ({
    default: module.FirstRunExperience,
  }))
);

// Tahoe design compatibility scope. The exported component keeps its historical
// name while the `.legacy-design` class remains Tailwind's active scope.
import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';

function ThemedToaster() {
  const { resolvedTheme } = useTheme();

  return <Toaster theme={resolvedTheme} />;
}

function MainAppContent() {
  const { t } = useTranslation(['app', 'common']);
  const { config, updateAndSaveConfig } = useUserSystem();
  const navigate = useNavigate();
  const location = useLocation();
  const maintenanceStartedRef = useRef(false);
  const crashPromptShownRef = useRef(false);
  const transport = useBackendTransport();
  const isDesktop = transport.environment === 'desktop';
  const isMainDesktopWindow = isDesktop && getCurrentWindow().label === 'main';
  const startupPromptStep = getStartupPromptStep({
    config,
    pathname: location.pathname,
  });

  const persistFirstRun = useCallback(
    async ({
      editor,
      defaultAgentId,
      skipped,
    }: {
      editor: NonNullable<typeof config>['editor'];
      defaultAgentId: NonNullable<
        typeof config
      >['executor_profile']['executor'];
      skipped: boolean;
    }) => {
      await updateAndSaveConfig({
        disclaimer_acknowledged: true,
        onboarding_acknowledged: true,
        ...(skipped
          ? {}
          : {
              editor,
              executor_profile: {
                executor: defaultAgentId,
                variant: null,
              },
            }),
      });
    },
    [updateAndSaveConfig]
  );

  const finishFirstRun = useCallback(() => {
    navigate('/local-projects', { replace: true });
  }, [navigate]);

  // Track previous path for back navigation
  usePreviousPath();

  // Scratch streams are desktop-only; Web keeps UI preferences local.
  useUiPreferencesScratch(isDesktop);

  useLegacyDesignBodyClass();

  useEffect(() => {
    if (!isDesktop) return;
    if (startupPromptStep !== 'dismiss-release-notes') return;
    let cancelled = false;

    const showNextStep = async () => {
      if (!cancelled) {
        await updateAndSaveConfig({ show_release_notes: false });
      }
    };

    showNextStep();

    return () => {
      cancelled = true;
    };
  }, [isDesktop, startupPromptStep, updateAndSaveConfig]);

  // Opt-in crash reporting: once the startup prompt chain is idle, surface the
  // newest locally captured crash report (full content, user decides whether to
  // file it). Runs at most once per app session.
  useEffect(() => {
    if (!isDesktop) return;
    if (!config?.crash_reports_enabled || crashPromptShownRef.current) return;
    const startupPromptStep = getStartupPromptStep({
      config,
      pathname: location.pathname,
    });
    if (startupPromptStep !== 'none') return;
    if (
      location.pathname.startsWith('/settings') ||
      location.pathname.startsWith('/plugins')
    ) {
      return;
    }

    crashPromptShownRef.current = true;
    let started = false;
    const cancelIdle = scheduleIdleWork(() => {
      started = true;
      void (async () => {
        try {
          const info = await crashReportsApi.list();
          const newest = info.reports[0];
          if (!newest) return;
          await CrashReportDialog.show({
            reportId: newest.id,
            repository: info.repository,
          });
          CrashReportDialog.hide();
        } catch (error) {
          console.error('Crash report check failed:', error);
        }
      })();
    });
    return () => {
      cancelIdle();
      if (!started) {
        crashPromptShownRef.current = false;
      }
    };
  }, [config, isDesktop, location.pathname]);

  useEffect(() => {
    if (!isDesktop || !config?.disclaimer_acknowledged) return;
    if (config.auto_update_enabled === false || maintenanceStartedRef.current)
      return;

    maintenanceStartedRef.current = true;
    let cancelled = false;

    const runMaintenance = async () => {
      try {
        const snapshot = await checkAppUpdate();
        if (cancelled || !snapshot.update) return;

        toast.warning(
          t('shell.appUpdateAvailable', {
            version: snapshot.update.version,
          }),
          {
            action: {
              label: t('shell.viewUpdate'),
              onClick: () => navigate('/settings/system'),
            },
          }
        );
      } catch (error) {
        if (!cancelled) {
          console.warn('System maintenance check failed:', error);
        }
      }
    };
    let started = false;
    const cancelIdle = scheduleIdleWork(() => {
      started = true;
      void runMaintenance();
    });

    return () => {
      cancelled = true;
      cancelIdle();
      if (!started) {
        maintenanceStartedRef.current = false;
      }
    };
  }, [config, isDesktop, navigate, t]);

  return (
    <ThemeProvider initialTheme={config?.theme || ThemeMode.SYSTEM}>
      <SearchProvider>
        <AgentWorkbenchProvider>
          {isMainDesktopWindow ? <ProjectWindowManager /> : null}
          {isDesktop ? <TrayBadgeSync /> : null}
          <ThemedToaster />
          <MainAppRoutes />
          {config && isDesktop && startupPromptStep === 'first-run' ? (
            <Suspense fallback={null}>
              <FirstRunExperience
                open
                initialEditor={config.editor}
                initialDefaultAgentId={config.executor_profile.executor}
                onPersist={persistFirstRun}
                onFinish={finishFirstRun}
              />
            </Suspense>
          ) : null}
        </AgentWorkbenchProvider>
      </SearchProvider>
    </ThemeProvider>
  );
}

function DesktopToastAppContent() {
  const { config } = useUserSystem();

  return (
    <ThemeProvider initialTheme={config?.theme || ThemeMode.SYSTEM}>
      <LegacyDesignScope className="!bg-transparent">
        <DesktopToastWindow />
      </LegacyDesignScope>
    </ThemeProvider>
  );
}

function AppContent() {
  const location = useLocation();
  const routeMode = getAppRouteMode(location.pathname);

  if (routeMode === 'desktop-toast') {
    return <DesktopToastAppContent />;
  }

  return <MainAppContent />;
}

function GlobalShortcutActionBridge() {
  useEffect(() => {
    const handleShortcut = (event: Event) => {
      const { actionId } = (event as CustomEvent<ShortcutActionEventDetail>)
        .detail;
      if (actionId === 'settings') {
        void settingsWindowApi.open();
      }
    };
    window.addEventListener(SHORTCUT_ACTION_EVENT, handleShortcut);
    return () =>
      window.removeEventListener(SHORTCUT_ACTION_EVENT, handleShortcut);
  }, []);
  return null;
}

function App() {
  return (
    <AppErrorBoundary>
      <BrowserRouter>
        <UserSystemProvider>
          <ClickedElementsProvider>
            <ProjectProvider>
              <HotkeysProvider
                initiallyActiveScopes={[
                  'global',
                  'workspace',
                  'kanban',
                  'projects',
                ]}
              >
                <SequenceTrackerProvider>
                  <GlobalShortcutActionBridge />
                  <AppContent />
                  <SequenceIndicator />
                </SequenceTrackerProvider>
              </HotkeysProvider>
            </ProjectProvider>
          </ClickedElementsProvider>
        </UserSystemProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  );
}

export default App;
