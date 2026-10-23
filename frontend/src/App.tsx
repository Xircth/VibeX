import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { usePreviousPath } from '@/hooks/usePreviousPath';
import { useUiPreferencesScratch } from '@/hooks/useUiPreferencesScratch';

import { UserSystemProvider, useUserSystem } from '@/components/ConfigProvider';
import { ThemeProvider, useTheme } from '@/components/ThemeProvider';
import { SearchProvider } from '@/contexts/SearchContext';
import { Toaster } from '@/components/ui/toast';
import { ProjectWindowManager } from '@/components/layout/ProjectWindowManager';
import { DesktopWindowControls } from '@/components/settings/DesktopWindowControls';
import { TrayBadgeSync } from '@/components/layout/TrayBadgeSync';
import { FocusConversationListener } from '@/components/layout/FocusConversationListener';
import { HotkeysProvider } from 'react-hotkeys-hook';

import { ProjectProvider } from '@/contexts/ProjectContext';
import { ThemeMode } from 'shared/types';

import { CrashReportDialog } from '@/components/dialogs/global/CrashReportDialog';
import { crashReportsApi } from '@/lib/api/crashReports';
import { ClickedElementsProvider } from './contexts/ClickedElementsProvider';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { useOpenSettings } from '@/lib/api';
import {
  checkAppUpdate,
  consumePostUpdateRestoreRoute,
  recordMainWindowRoute,
} from '@/lib/appUpdate';
import { getStartupPromptStep } from '@/appStartupPrompt';
import { getAppRouteMode } from '@/appRouteMode';
import { useLegacyDesignBodyClass } from '@/useLegacyDesignBodyClass';
import { useOptionMenuViewportFit } from '@/components/ui/option-menu-position';
import { isSettingsSurfacePath } from '@/lib/settingsPreload';
import { AgentWorkbenchProvider } from '@/features/agents/useAgentWorkbench';
import { scheduleIdleWork } from '@/lib/scheduleIdleWork';
import { revealDesktopWindowAfterPaint } from '@/lib/revealDesktopWindow';
import { useTauriClient } from '@/lib/desktopShell';
import { useRemoteHostReleaseUpdateToast } from '@/hooks/useRemoteHostReleaseUpdateToast';
import { usePluginContributionCatalogSync } from '@/hooks/usePluginHostContributions';
import { useProviderBindConfirmations } from '@/hooks/useProviderBindConfirmations';
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
const SettingsAppRoutes = lazy(() =>
  import('@/SettingsAppRoutes').then((module) => ({
    default: module.SettingsAppRoutes,
  }))
);
const DesktopToastApp = lazy(() =>
  import('@/DesktopToastApp').then((module) => ({
    default: module.DesktopToastApp,
  }))
);
const MainAppRoutes = lazy(() =>
  import('@/MainAppRoutes').then((module) => ({
    default: module.MainAppRoutes,
  }))
);

import { AppContextMenuHost } from '@/components/context-menu';
import {
  BasicGuideOverlay,
  BasicGuideProvider,
  readBasicGuide,
  skipBasicGuide,
  startBasicGuide,
  writeBasicGuide,
} from '@/features/basic-guide';

function ThemedToaster() {
  const { resolvedTheme } = useTheme();

  return <Toaster theme={resolvedTheme} />;
}

function MainAppContent({ children }: { children: ReactNode }) {
  const { config, updateAndSaveConfig } = useUserSystem();
  const navigate = useNavigate();
  const location = useLocation();
  const maintenanceStartedRef = useRef(false);
  const crashPromptShownRef = useRef(false);
  const postUpdateRestoreHandledRef = useRef(false);
  const isTauri = useTauriClient();
  const isMainDesktopWindow = isTauri && getCurrentWindow().label === 'main';
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
      // The guide stays mounted only while onboarding is unacknowledged.
      // Saving the choices here must not dismiss it; acknowledgement waits
      // until the user skips or leaves the install step.
      if (skipped) {
        writeBasicGuide(skipBasicGuide());
      }
      await updateAndSaveConfig(
        skipped
          ? {
              disclaimer_acknowledged: true,
              onboarding_acknowledged: true,
            }
          : {
              editor,
              executor_profile: {
                executor: defaultAgentId,
                variant: null,
              },
            }
      );
    },
    [updateAndSaveConfig]
  );

  const finishFirstRun = useCallback(() => {
    void updateAndSaveConfig({
      disclaimer_acknowledged: true,
      onboarding_acknowledged: true,
    }).then(() => {
      const current = readBasicGuide();
      if (current?.phase !== 'completed') {
        writeBasicGuide(startBasicGuide(current));
      }
      navigate('/local-projects', { replace: true });
    });
  }, [navigate, updateAndSaveConfig]);

  // Track previous path for back navigation
  usePreviousPath();

  useEffect(() => {
    if (isSettingsSurfacePath(location.pathname)) return;
    const currentRoute = `${location.pathname}${location.search}${location.hash}`;
    if (!postUpdateRestoreHandledRef.current) {
      postUpdateRestoreHandledRef.current = true;
      const restoreRoute = consumePostUpdateRestoreRoute();
      if (restoreRoute && restoreRoute !== currentRoute) {
        navigate(restoreRoute, { replace: true });
        return;
      }
    }
    recordMainWindowRoute(currentRoute);
  }, [location.hash, location.pathname, location.search, navigate]);

  // Scratch streams are desktop-shell; Web keeps UI preferences local.
  useUiPreferencesScratch(isTauri);
  useRemoteHostReleaseUpdateToast();

  useLegacyDesignBodyClass();
  useOptionMenuViewportFit();

  useEffect(() => revealDesktopWindowAfterPaint(), []);

  useEffect(() => {
    if (!isTauri) return;
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
  }, [isTauri, startupPromptStep, updateAndSaveConfig]);

  // Opt-in crash reporting: once the startup prompt chain is idle, surface the
  // newest locally captured crash report (full content, user decides whether to
  // file it). Runs at most once per app session.
  useEffect(() => {
    if (!isTauri) return;
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
  }, [config, isTauri, location.pathname]);

  useEffect(() => {
    if (!isTauri || !config?.disclaimer_acknowledged) return;
    if (config.auto_update_enabled === false || maintenanceStartedRef.current)
      return;

    maintenanceStartedRef.current = true;
    let cancelled = false;

    const runMaintenance = async () => {
      try {
        await checkAppUpdate();
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
  }, [config, isTauri]);

  return (
    <ThemeProvider initialTheme={config?.theme || ThemeMode.SYSTEM}>
      <SearchProvider>
        <AgentWorkbenchProvider>
          {isMainDesktopWindow ? <ProjectWindowManager /> : null}
          {isTauri ? <TrayBadgeSync /> : null}
          {isTauri ? <DesktopWindowControls /> : null}
          <ThemedToaster />
          {children}
          {config && isTauri && startupPromptStep === 'first-run' ? (
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

function AppContent() {
  const location = useLocation();
  const routeMode = getAppRouteMode(location.pathname);

  if (routeMode === 'desktop-toast') {
    return (
      <Suspense fallback={null}>
        <DesktopToastApp />
      </Suspense>
    );
  }

  const routes = isSettingsSurfacePath(location.pathname) ? (
    <Suspense fallback={null}>
      <SettingsAppRoutes />
    </Suspense>
  ) : (
    <Suspense fallback={null}>
      <MainAppRoutes />
    </Suspense>
  );

  return (
    <ClickedElementsProvider>
      <ProjectProvider>
        <HotkeysProvider
          initiallyActiveScopes={['global', 'workspace', 'kanban', 'projects']}
        >
          <SequenceTrackerProvider>
            <GlobalShortcutActionBridge />
            <PluginContributionBridge />
            <FocusConversationListener />
            <AppContextMenuHost>
              <BasicGuideProvider>
                <MainAppContent>{routes}</MainAppContent>
                <BasicGuideOverlay />
              </BasicGuideProvider>
            </AppContextMenuHost>
            <SequenceIndicator />
          </SequenceTrackerProvider>
        </HotkeysProvider>
      </ProjectProvider>
    </ClickedElementsProvider>
  );
}

function GlobalShortcutActionBridge() {
  const openSettings = useOpenSettings();
  useEffect(() => {
    const handleShortcut = (event: Event) => {
      const { actionId } = (event as CustomEvent<ShortcutActionEventDetail>)
        .detail;
      if (actionId !== 'settings') return;
      openSettings();
    };
    window.addEventListener(SHORTCUT_ACTION_EVENT, handleShortcut);
    return () =>
      window.removeEventListener(SHORTCUT_ACTION_EVENT, handleShortcut);
  }, [openSettings]);
  return null;
}

function PluginContributionBridge() {
  usePluginContributionCatalogSync();
  useProviderBindConfirmations();
  return null;
}

function App() {
  return (
    <AppErrorBoundary>
      <BrowserRouter>
        <UserSystemProvider>
          <AppContent />
        </UserSystemProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  );
}

export default App;
