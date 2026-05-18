import { useEffect, useRef } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { Projects } from '@/pages/Projects';
import { ProjectTasks } from '@/pages/ProjectTasks';
import { FullAttemptLogsPage } from '@/pages/FullAttemptLogs';
import { NormalLayout } from '@/components/layout/NormalLayout';
import { IDEWorkspaceRoute } from '@/components/layout/IDEWorkspaceRoute';
import { usePreviousPath } from '@/hooks/usePreviousPath';
import { useUiPreferencesScratch } from '@/hooks/useUiPreferencesScratch';

import {
  AgentSettings,
  AppearanceSettings,
  EditorSettings,
  McpSettings,
  SkillsSettings,
  ShortcutSettings,
  SystemSettings,
  SettingsLayout,
} from '@/pages/settings/';
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

// Design scope components
import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';

function ThemedToaster() {
  const { resolvedTheme } = useTheme();

  return <Toaster theme={resolvedTheme} />;
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

  useEffect(() => {
    document.body.classList.add('legacy-design');
    return () => {
      document.body.classList.remove('legacy-design');
    };
  }, []);

  useEffect(() => {
    if (!config) return;
    if (location.pathname.startsWith('/settings')) return;
    let cancelled = false;

    const showNextStep = async () => {
      // 1) Disclaimer - first step
      if (!config.disclaimer_acknowledged) {
        await DisclaimerDialog.show();
        if (!cancelled) {
          await updateAndSaveConfig({ disclaimer_acknowledged: true });
          navigate('/local-projects', { replace: true });
        }
        DisclaimerDialog.hide();
        return;
      }

      // 2) Onboarding - configure executor and editor
      if (!config.onboarding_acknowledged) {
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
      if (config.show_release_notes) {
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
    if (!config || maintenanceStartedRef.current) return;
    if (!config.disclaimer_acknowledged) {
      return;
    }
    if (
      config.auto_update_enabled === false &&
      config.auto_install_local_dependencies === false
    ) {
      return;
    }

    maintenanceStartedRef.current = true;
    let cancelled = false;

    const runMaintenance = async () => {
      const localEnvironmentToastId =
        config.auto_install_local_dependencies !== false
          ? toast.loading('正在检查本地环境...')
          : null;

      try {
        const status = await configApi.getSystemMaintenanceStatus();
        if (cancelled) {
          if (localEnvironmentToastId) {
            toast.dismiss(localEnvironmentToastId);
          }
          return;
        }

        if (
          config.auto_update_enabled !== false &&
          status.app.update_available
        ) {
          toast.warning(
            `VibeX ${status.app.latest_version} is available.`,
            {
              action: status.app.release_url
                ? {
                    label: 'Open release',
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

        if (config.auto_install_local_dependencies !== false) {
          const visibleTools = status.tools.filter((tool) => tool.user_visible);
          const groupsNeedingMaintenance = new Set(
            status.tools
              .filter(
                (tool) =>
                  !tool.installed || !tool.supported || tool.update_available
              )
              .map((tool) => tool.group_id)
          );
          const toolsNeedingDecision = visibleTools.filter((tool) =>
            groupsNeedingMaintenance.has(tool.group_id)
          );

          if (toolsNeedingDecision.length === 0) {
            toast.success('本地环境检查完成。', {
              id: localEnvironmentToastId ?? undefined,
              duration: 3000,
            });
          } else {
            if (localEnvironmentToastId) {
              toast.dismiss(localEnvironmentToastId);
            }
          }

          const installLocalDependencyGroup = async (tool: LocalToolStatus) => {
            const toastId = toast.loading(`正在更新 ${tool.label} 本地依赖...`);
            try {
              await configApi.installSystemDependencies(false, [tool.id]);
              if (!cancelled) {
                toast.success(`${tool.label} 本地依赖已更新。`, {
                  id: toastId,
                });
              }
            } catch (error) {
              if (!cancelled) {
                toast.error(
                  error instanceof Error
                    ? error.message
                    : `${tool.label} 本地依赖更新失败。`,
                  { id: toastId }
                );
              }
            }
          };

          for (const tool of toolsNeedingDecision) {
            const currentVersion = tool.installed_version ?? '未安装';
            const minimumVersion =
              tool.minimum_supported_version ??
              tool.latest_version ??
              '未知';
            const unsupportedCli = !tool.installed || !tool.supported;
            const message = unsupportedCli
              ? `${tool.label} 版本不符合要求`
              : `${tool.label} 本地依赖需要更新`;
            const description = unsupportedCli
              ? `当前版本：${currentVersion}，最低支持版本：${minimumVersion}，请确认是否更新？`
              : `当前版本：${currentVersion}，建议更新本地依赖以保持可用。`;

            const toastId = toast.warning(message, {
              description,
              duration: 15000,
              action: {
                label: '确认',
                onClick: () => {
                  toast.dismiss(toastId);
                  void installLocalDependencyGroup(tool);
                },
              },
              cancel: {
                label: '取消',
                onClick: () => toast.dismiss(toastId),
              },
            });
          }
        }
      } catch (error) {
        if (!cancelled) {
          if (localEnvironmentToastId) {
            toast.error('本地环境检查失败。', {
              id: localEnvironmentToastId,
            });
          }
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
        <ThemedToaster />
        <Routes>
          {/* ========== FULL-PAGE ROUTES (outside layout) ========== */}
          <Route
            path="/local-projects/:projectId/workspaces/:workspaceId/full"
            element={
              <LegacyDesignScope>
                <FullAttemptLogsPage />
              </LegacyDesignScope>
            }
          />

          {/* ========== IDE WORKSPACE ROUTES (dockview layout) ========== */}
          <Route
            element={
              <LegacyDesignScope>
                <IDEWorkspaceRoute />
              </LegacyDesignScope>
            }
          >
            <Route
              path="/local-projects/:projectId/sessions"
              element={<ProjectTasks />}
            />
            <Route
              path="/local-projects/:projectId/workspaces/:workspaceId"
              element={<ProjectTasks />}
            />
            <Route
              path="/local-projects/:projectId/workspaces/:workspaceId/sessions/:sessionId"
              element={<ProjectTasks />}
            />
          </Route>

          {/* ========== SETTINGS ROUTES (standalone layout, no Navbar) ========== */}
          <Route
            path="/settings/*"
            element={
              <LegacyDesignScope>
                <SettingsLayout />
              </LegacyDesignScope>
            }
          >
            <Route index element={<Navigate to="agents" replace />} />
            <Route path="agents" element={<AgentSettings />} />
            <Route path="mcp" element={<McpSettings />} />
            <Route path="skills" element={<SkillsSettings />} />
            <Route path="shortcuts" element={<ShortcutSettings />} />
            <Route path="editor" element={<EditorSettings />} />
            <Route path="appearance" element={<AppearanceSettings />} />
            <Route path="system" element={<SystemSettings />} />
          </Route>

          {/* ========== LEGACY DESIGN ROUTES (standard layout) ========== */}
          <Route
            element={
              <LegacyDesignScope>
                <NormalLayout />
              </LegacyDesignScope>
            }
          >
            <Route path="/" element={<Projects />} />
            <Route path="/local-projects" element={<Projects />} />
            <Route path="/local-projects/:projectId" element={<Projects />} />
            <Route
              path="/mcp-servers"
              element={<Navigate to="/settings/mcp" replace />}
            />

            {/* Redirect disabled new UI routes back to legacy UI */}
            <Route
              path="/workspaces/*"
              element={<Navigate to="/local-projects" replace />}
            />
            <Route
              path="/projects/*"
              element={<Navigate to="/local-projects" replace />}
            />
          </Route>
        </Routes>
      </SearchProvider>
    </ThemeProvider>
  );
}

function DesktopToastAppContent() {
  const { config } = useUserSystem();

  return (
    <ThemeProvider initialTheme={config?.theme || ThemeMode.SYSTEM}>
      <DesktopToastWindow />
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

  if (location.pathname === '/desktop-toast') {
    return <DesktopToastAppContent />;
  }

  if (location.pathname === '/project-rail') {
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
