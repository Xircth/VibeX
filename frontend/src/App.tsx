import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Minimize2, Power, X } from 'lucide-react';
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

import { FirstRunExperience } from '@/components/onboarding/FirstRunExperience';
import { CrashReportDialog } from '@/components/dialogs/global/CrashReportDialog';
import { crashReportsApi } from '@/lib/api/crashReports';
import { ClickedElementsProvider } from './contexts/ClickedElementsProvider';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { configApi, settingsWindowApi, type LocalToolStatus } from '@/lib/api';
import { backendListen } from '@/lib/backendTransport';
import { getStartupPromptStep } from '@/appStartupPrompt';
import {
  getLocalDependencyUpdatePromptTools,
  shouldShowAppUpdateToast,
  shouldStartSystemMaintenance,
} from '@/appMaintenancePlan';
import { getAppRouteMode } from '@/appRouteMode';
import { useLegacyDesignBodyClass } from '@/useLegacyDesignBodyClass';
import {
  getSavedMainWindowCloseBehavior,
  performMainWindowCloseBehavior,
  saveMainWindowCloseBehavior,
  type MainWindowCloseBehavior,
} from '@/mainWindowCloseBehavior';
import { MainAppRoutes } from '@/MainAppRoutes';
import { AgentWorkbenchProvider } from '@/features/agents/useAgentWorkbench';
import { useBackendTransport } from '@/lib/transport';
import {
  SequenceIndicator,
  SequenceTrackerProvider,
  SHORTCUT_ACTION_EVENT,
  type ShortcutActionEventDetail,
} from '@/keyboard';

// Tahoe design compatibility scope. The exported component keeps its historical
// name while the `.legacy-design` class remains Tailwind's active scope.
import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';

function MainWindowCloseToastBridge() {
  const { t } = useTranslation(['app', 'common']);
  const [isOpen, setIsOpen] = useState(false);
  const [rememberBehavior, setRememberBehavior] = useState(true);

  const chooseBehavior = useCallback(
    (behavior: MainWindowCloseBehavior) => {
      if (rememberBehavior) {
        saveMainWindowCloseBehavior(behavior);
      }
      setIsOpen(false);
      void performMainWindowCloseBehavior(behavior);
    },
    [rememberBehavior]
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    backendListen<void>('main-window-close-requested', () => {
      const savedBehavior = getSavedMainWindowCloseBehavior();
      if (savedBehavior) {
        void performMainWindowCloseBehavior(savedBehavior);
        return;
      }
      setRememberBehavior(true);
      setIsOpen(true);
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/55 p-4 backdrop-blur-sm"
      role="presentation"
    >
      <section
        className="w-[min(520px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="main-window-close-title"
      >
        <div className="flex items-start gap-4 px-6 pb-4 pt-6">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Power className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id="main-window-close-title"
              className="text-base font-semibold"
            >
              {t('shell.closeBehaviorTitle')}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t('shell.closeBehaviorDescription')}
            </p>
          </div>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t('shell.closeBehaviorDismissAria')}
            onClick={() => setIsOpen(false)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="mx-6 mb-5 flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border accent-primary"
            checked={rememberBehavior}
            onChange={(event) => setRememberBehavior(event.target.checked)}
          />
          {t('shell.closeBehaviorRemember')}
        </label>
        <div className="grid grid-cols-2 gap-3 border-t border-border/80 p-4">
          <button
            type="button"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            onClick={() => chooseBehavior('exit')}
          >
            <Power className="h-4 w-4" />
            {t('shell.closeBehaviorExit')}
          </button>
          <button
            type="button"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-muted px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/80"
            onClick={() => chooseBehavior('minimize')}
          >
            <Minimize2 className="h-4 w-4" />
            {t('shell.closeBehaviorMinimize')}
          </button>
        </div>
      </section>
    </div>
  );
}

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
    if (location.pathname.startsWith('/settings')) return;

    crashPromptShownRef.current = true;
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
  }, [config, isDesktop, location.pathname]);

  useEffect(() => {
    if (!isDesktop) return;
    if (
      !shouldStartSystemMaintenance({
        config,
        hasStarted: maintenanceStartedRef.current,
      })
    ) {
      return;
    }

    maintenanceStartedRef.current = true;
    let cancelled = false;

    const runMaintenance = async () => {
      try {
        const status = await configApi.getSystemMaintenanceStatus();
        if (cancelled) return;

        if (shouldShowAppUpdateToast({ config, status })) {
          toast.warning(
            t('shell.appUpdateAvailable', {
              version: status.app.latest_version,
            }),
            {
              action: status.app.release_url
                ? {
                    label: t('shell.openReleasePage'),
                    onClick: () =>
                      window.open(
                        status.app.release_url!,
                        '_blank',
                        'noopener,noreferrer'
                      ),
                  }
                : undefined,
            }
          );
        }

        const toolsNeedingDecision = getLocalDependencyUpdatePromptTools({
          config,
          tools: status.tools,
        });

        if (toolsNeedingDecision.length > 0) {
          const installLocalDependencyGroups = async (
            tools: LocalToolStatus[]
          ) => {
            const toastId = toast.loading(t('shell.updatingDependencies'));
            try {
              await configApi.installSystemDependencies(
                false,
                tools.map((tool) => tool.id)
              );
              if (!cancelled) {
                toast.success(t('shell.dependenciesUpdated'), {
                  id: toastId,
                });
              }
            } catch (error) {
              if (!cancelled) {
                toast.error(
                  error instanceof Error
                    ? error.message
                    : t('shell.dependenciesUpdateFailed'),
                  { id: toastId }
                );
              }
            }
          };

          const dependencyTitle =
            toolsNeedingDecision.length > 1
              ? t('shell.dependencyUpdateTitleMany', {
                  count: toolsNeedingDecision.length,
                })
              : t('shell.dependencyUpdateTitleOne');
          toast.warning(dependencyTitle, {
            description: t('shell.dependencyUpdatePrompt'),
            duration: 15_000,
            details: toolsNeedingDecision.map((tool) => ({
              title: tool.label,
              mono: true,
              description: `${t('shell.dependencyCurrentVersion', {
                version:
                  tool.installed_version ?? t('shell.dependencyNotInstalled'),
              })}${
                tool.minimum_supported_version
                  ? t('shell.dependencyMinimumSupported', {
                      version: tool.minimum_supported_version,
                    })
                  : ''
              }${
                tool.latest_version
                  ? t('shell.dependencyLatestVersion', {
                      version: tool.latest_version,
                    })
                  : ''
              }`,
            })),
            cancel: {
              label: t('shell.dependencyLater'),
              onClick: () => undefined,
            },
            action: {
              label: t('shell.dependencyUpdate'),
              onClick: () => {
                void installLocalDependencyGroups(toolsNeedingDecision);
              },
            },
          });
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('System maintenance check failed:', error);
        }
      }
    };
    void runMaintenance();

    return () => {
      cancelled = true;
    };
  }, [config, isDesktop, t]);

  return (
    <ThemeProvider initialTheme={config?.theme || ThemeMode.SYSTEM}>
      <SearchProvider>
        <AgentWorkbenchProvider>
          {isDesktop ? <ProjectWindowManager /> : null}
          {isDesktop ? <TrayBadgeSync /> : null}
          {isDesktop ? <MainWindowCloseToastBridge /> : null}
          <ThemedToaster />
          <MainAppRoutes />
          {config ? (
            <FirstRunExperience
              open={isDesktop && startupPromptStep === 'first-run'}
              initialEditor={config.editor}
              initialDefaultAgentId={config.executor_profile.executor}
              onPersist={persistFirstRun}
              onFinish={finishFirstRun}
            />
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
