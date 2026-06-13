import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronDown, Minimize2, Power, X } from 'lucide-react';
import { usePreviousPath } from '@/hooks/usePreviousPath';
import { useUiPreferencesScratch } from '@/hooks/useUiPreferencesScratch';

import { UserSystemProvider, useUserSystem } from '@/components/ConfigProvider';
import { ThemeProvider, useTheme } from '@/components/ThemeProvider';
import { SearchProvider } from '@/contexts/SearchContext';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { ProjectWindowManager } from '@/components/layout/ProjectWindowManager';
import { DesktopToastWindow } from '@/components/desktop-toast/DesktopToastWindow';
import { ProjectRail } from '@/components/layout/ProjectRail';

import { HotkeysProvider } from 'react-hotkeys-hook';

import { ProjectProvider } from '@/contexts/ProjectContext';
import { ThemeMode } from 'shared/types';

import { DisclaimerDialog } from '@/components/dialogs/global/DisclaimerDialog';
import { OnboardingDialog } from '@/components/dialogs/global/OnboardingDialog';
import { ClickedElementsProvider } from './contexts/ClickedElementsProvider';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { configApi, type LocalToolStatus } from '@/lib/api';
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

// Tahoe design compatibility scope. The exported component keeps its historical
// name while the `.legacy-design` class remains Tailwind's active scope.
import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';

function MainWindowCloseToastBridge() {
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
            <h2 id="main-window-close-title" className="text-base font-semibold">
              选择关闭行为
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              退出应用会结束 VibeX，最小化会保留当前窗口状态。
            </p>
          </div>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="关闭提示"
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
          下次保持该行为，不再询问
        </label>
        <div className="grid grid-cols-2 gap-3 border-t border-border/80 p-4">
          <button
            type="button"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            onClick={() => chooseBehavior('exit')}
          >
            <Power className="h-4 w-4" />
            退出应用
          </button>
          <button
            type="button"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-muted px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/80"
            onClick={() => chooseBehavior('minimize')}
          >
            <Minimize2 className="h-4 w-4" />
            最小化
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

function LocalDependencyUpdateToast({
  toastId,
  tools,
  onUpdate,
}: {
  toastId: string | number;
  tools: LocalToolStatus[];
  onUpdate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const title =
    tools.length > 1
      ? `有 ${tools.length} 个依赖需要更新`
      : '有依赖需要更新';

  return (
    <div
      className="flex w-[min(520px,calc(100vw-32px))] cursor-pointer gap-3 rounded-xl border border-border bg-background p-4 text-foreground shadow-xl"
      role="button"
      tabIndex={0}
      onClick={() => setExpanded((value) => !value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setExpanded((value) => !value);
        }
      }}
    >
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-300">
        <AlertTriangle className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold leading-5">{title}</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              是否现在更新本地 Agent 依赖？
            </div>
          </div>
          <ChevronDown
            className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
              expanded ? 'rotate-180' : ''
            }`}
          />
        </div>

        {expanded ? (
          <div className="mt-3 max-h-[min(60vh,320px)] space-y-2 overflow-y-auto border-t border-border/70 pt-3 pr-1">
            {tools.map((tool) => (
              <div
                key={tool.id}
                className="rounded-lg bg-muted/55 px-3 py-2 text-xs leading-5"
              >
                <div className="font-medium text-foreground">{tool.label}</div>
                <div className="text-muted-foreground">
                  当前版本：{tool.installed_version ?? '未安装'}
                  {tool.minimum_supported_version
                    ? `，最低支持：${tool.minimum_supported_version}`
                    : ''}
                  {tool.latest_version ? `，可更新：${tool.latest_version}` : ''}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="h-8 rounded-full bg-muted px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              toast.dismiss(toastId);
            }}
          >
            稍后
          </button>
          <button
            type="button"
            className="h-8 rounded-full bg-foreground px-3 text-xs font-medium text-background transition-colors hover:bg-foreground/90"
            onClick={(event) => {
              event.stopPropagation();
              onUpdate();
            }}
          >
            更新
          </button>
        </div>
      </div>
    </div>
  );
}

function MainAppContent() {
  const { config, updateAndSaveConfig } = useUserSystem();
  const navigate = useNavigate();
  const location = useLocation();
  const maintenanceStartedRef = useRef(false);

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
          toast.warning(`VibeX ${status.app.latest_version} 可更新。`, {
            action: status.app.release_url
              ? {
                  label: '打开发布页',
                  onClick: () =>
                    window.open(
                      status.app.release_url!,
                      '_blank',
                      'noopener,noreferrer'
                    ),
                }
              : undefined,
          });
        }

        const toolsNeedingDecision = getLocalDependencyUpdatePromptTools({
          config,
          tools: status.tools,
        });

        if (toolsNeedingDecision.length > 0) {
          const installLocalDependencyGroups = async (
            tools: LocalToolStatus[]
          ) => {
            const toastId = toast.loading('正在更新本地 Agent 依赖...');
            try {
              await configApi.installSystemDependencies(
                false,
                tools.map((tool) => tool.id)
              );
              if (!cancelled) {
                toast.success('本地 Agent 依赖已更新。', {
                  id: toastId,
                });
              }
            } catch (error) {
              if (!cancelled) {
                toast.error(
                  error instanceof Error
                    ? error.message
                    : '本地 Agent 依赖更新失败。',
                  { id: toastId }
                );
              }
            }
          };

          toast.custom(
            (toastId) => (
              <LocalDependencyUpdateToast
                toastId={toastId}
                tools={toolsNeedingDecision}
                onUpdate={() => {
                  toast.dismiss(toastId);
                  void installLocalDependencyGroups(toolsNeedingDecision);
                }}
              />
            ),
            {
              duration: 15000,
              unstyled: true,
              closeButton: false,
              classNames: {
                toast: 'vu-local-dependency-toast-shell',
              },
            }
          );
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
  }, [config]);

  return (
    <ThemeProvider initialTheme={config?.theme || ThemeMode.SYSTEM}>
      <SearchProvider>
        <ProjectWindowManager />
        <MainWindowCloseToastBridge />
        <ThemedToaster />
        <MainAppRoutes />
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

function ProjectRailAppContent() {
  const { config } = useUserSystem();

  return (
    <ThemeProvider initialTheme={config?.theme || ThemeMode.SYSTEM}>
      <SearchProvider>
        <ProjectWindowManager />
        <LegacyDesignScope className="h-screen !min-h-0 overflow-hidden !bg-transparent">
          <ProjectRail standalone />
        </LegacyDesignScope>
      </SearchProvider>
    </ThemeProvider>
  );
}

function AppContent() {
  const location = useLocation();
  const routeMode = getAppRouteMode(location.pathname);

  if (routeMode === 'desktop-toast') {
    return <DesktopToastAppContent />;
  }

  if (routeMode === 'project-rail') {
    return <ProjectRailAppContent />;
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
