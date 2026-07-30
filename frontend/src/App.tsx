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

import { DisclaimerDialog } from '@/components/dialogs/global/DisclaimerDialog';
import { OnboardingDialog } from '@/components/dialogs/global/OnboardingDialog';
import { CrashReportDialog } from '@/components/dialogs/global/CrashReportDialog';
import { crashReportsApi } from '@/lib/api/crashReports';
import { ClickedElementsProvider } from './contexts/ClickedElementsProvider';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import {
  configApi,
  type LocalToolStatus,
} from '@/lib/api';
import { tauriListen } from '@/lib/tauriApi';
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

    tauriListen<void>('main-window-close-requested', () => {
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

  // Track previous path for back navigation
  usePreviousPath();

  // Sync UI preferences with server scratch storage
  useUiPreferencesScratch();

  useLegacyDesignBodyClass();

  useEffect(() => {
    const startupPromptStep = getStartupPromptStep({
      config,
      pathname: location.pathname,
    });
    if (startupPromptStep === 'none') return;
    let cancelled = false;

    const showNextStep = async () => {
      // 1) Disclaimer - first step
      if (startupPromptStep === 'disclaimer') {
        await DisclaimerDialog.show();
        if (!cancelled) {
          await updateAndSaveConfig({ disclaimer_acknowledged: true });
          navigate('/local-projects', { replace: true });
        }
        DisclaimerDialog.hide();
        return;
      }

      // 2) Onboarding - configure executor and editor
      if (startupPromptStep === 'onboarding') {
        const result = await OnboardingDialog.show();
        if (!cancelled) {
          await updateAndSaveConfig({
            onboarding_acknowledged: true,
            executor_profile: result.profile,
            editor: result.editor,
          });
          navigate('/local-projects', { replace: true });
        }
        OnboardingDialog.hide();
        return;
      }

      // 3) Release notes - silently dismiss legacy update announcement
      if (startupPromptStep === 'dismiss-release-notes') {
        if (!cancelled) {
          await updateAndSaveConfig({ show_release_notes: false });
        }
        return;
      }
    };

    showNextStep();

    return () => {
      cancelled = true;
    };
  }, [config, location.pathname, navigate, updateAndSaveConfig]);

  // Opt-in crash reporting: once the startup prompt chain is idle, surface the
  // newest locally captured crash report (full content, user decides whether to
  // file it). Runs at most once per app session.
  useEffect(() => {
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
  }, [config, location.pathname]);

  useEffect(() => {
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
  }, [config, t]);

  return (
    <ThemeProvider initialTheme={config?.theme || ThemeMode.SYSTEM}>
      <SearchProvider>
        <AgentWorkbenchProvider>
          <ProjectWindowManager />
          <TrayBadgeSync />
          <MainWindowCloseToastBridge />
          <ThemedToaster />
          <MainAppRoutes />
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
                <AppContent />
              </HotkeysProvider>
            </ProjectProvider>
          </ClickedElementsProvider>
        </UserSystemProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  );
}

export default App;
