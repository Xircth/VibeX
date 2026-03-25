import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Projects } from '@/pages/Projects';
import { ProjectTasks } from '@/pages/ProjectTasks';
import { FullAttemptLogsPage } from '@/pages/FullAttemptLogs';
import { NormalLayout } from '@/components/layout/NormalLayout';
import { IDEWorkspaceRoute } from '@/components/layout/IDEWorkspaceRoute';
import { usePreviousPath } from '@/hooks/usePreviousPath';
import { useUiPreferencesScratch } from '@/hooks/useUiPreferencesScratch';
import { skillsApi } from '@/lib/api';

import {
  AgentSettings,
  EditorSettings,
  McpSettings,
  SkillsSettings,
  ShortcutSettings,
  SystemSettings,
  SettingsLayout,
} from '@/pages/settings/';
import { UserSystemProvider, useUserSystem } from '@/components/ConfigProvider';
import { ThemeProvider } from '@/components/ThemeProvider';
import { SearchProvider } from '@/contexts/SearchContext';
import { Toaster } from '@/components/ui/sonner';
import { ProjectWindowManager } from '@/components/layout/ProjectWindowManager';

import { HotkeysProvider } from 'react-hotkeys-hook';

import { ProjectProvider } from '@/contexts/ProjectContext';
import { ThemeMode } from 'shared/types';

import { DisclaimerDialog } from '@/components/dialogs/global/DisclaimerDialog';
import { OnboardingDialog } from '@/components/dialogs/global/OnboardingDialog';
import { ClickedElementsProvider } from './contexts/ClickedElementsProvider';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';

// Design scope components
import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';

function AppContent() {
  const { config, updateAndSaveConfig } = useUserSystem();

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

  // Silently install ai-max commands on first launch
  useEffect(() => {
    skillsApi.ensureAimaxInstalled().catch(() => {
      // Non-critical, ignore errors
    });
  }, []);

  useEffect(() => {
    if (!config) return;
    let cancelled = false;

    const showNextStep = async () => {
      // 1) Disclaimer - first step
      if (!config.disclaimer_acknowledged) {
        await DisclaimerDialog.show();
        if (!cancelled) {
          await updateAndSaveConfig({ disclaimer_acknowledged: true });
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
  }, [config, updateAndSaveConfig]);

  return (
    <ThemeProvider initialTheme={config?.theme || ThemeMode.SYSTEM}>
      <SearchProvider>
        <ProjectWindowManager />
        <Toaster />
        <Routes>
          {/* ========== FULL-PAGE ROUTES (outside layout) ========== */}
          <Route
            path="/local-projects/:projectId/tasks/:taskId/attempts/:attemptId/full"
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
              path="/local-projects/:projectId/tasks"
              element={<ProjectTasks />}
            />
            <Route
              path="/local-projects/:projectId/tasks/:taskId"
              element={<ProjectTasks />}
            />
            <Route
              path="/local-projects/:projectId/tasks/:taskId/attempts/:attemptId"
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
