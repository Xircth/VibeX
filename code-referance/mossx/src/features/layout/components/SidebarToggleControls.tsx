import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isWindowsPlatform } from "../../../utils/platform";
import PanelLeftClose from "lucide-react/dist/esm/icons/panel-left-close";
import PanelLeftOpen from "lucide-react/dist/esm/icons/panel-left-open";
import PanelRightClose from "lucide-react/dist/esm/icons/panel-right-close";

export type SidebarToggleProps = {
  isCompact: boolean;
  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  rightPanelAvailable?: boolean;
  onCollapseSidebar: () => void;
  onExpandSidebar: () => void;
  onCollapseRightPanel: () => void;
  onExpandRightPanel: () => void;
};

export function SidebarCollapseButton({
  isCompact,
  sidebarCollapsed,
  onExpandSidebar,
  onCollapseSidebar,
}: SidebarToggleProps) {
  const { t } = useTranslation();
  if (isCompact) {
    return null;
  }
  const isCollapsed = sidebarCollapsed;
  const labelKey = isCollapsed ? "sidebar.showThreadsSidebar" : "sidebar.hideThreadsSidebar";
  return (
    <button
      type="button"
      className="ghost main-header-action"
      onClick={isCollapsed ? onExpandSidebar : onCollapseSidebar}
      data-tauri-drag-region="false"
      aria-label={t(labelKey)}
      title={t(labelKey)}
    >
      {isCollapsed ? <PanelLeftOpen size={14} aria-hidden /> : <PanelLeftClose size={14} aria-hidden />}
    </button>
  );
}

export function RightPanelCollapseButton({
  isCompact,
  rightPanelCollapsed,
  rightPanelAvailable = true,
  onCollapseRightPanel,
}: SidebarToggleProps) {
  const { t } = useTranslation();
  if (isCompact || rightPanelCollapsed || !rightPanelAvailable) {
    return null;
  }
  return (
    <button
      type="button"
      className="ghost main-header-action"
      onClick={onCollapseRightPanel}
      data-tauri-drag-region="false"
      aria-label={t("sidebar.hideGitSidebar")}
      title={t("sidebar.hideGitSidebar")}
    >
      <PanelRightClose size={14} aria-hidden />
    </button>
  );
}

function WindowControls() {
  const { t } = useTranslation();
  const [isMaximized, setIsMaximized] = useState(false);

  const syncMaximizedState = useCallback(async () => {
    try {
      const maximized = await getCurrentWindow().isMaximized();
      setIsMaximized(maximized);
    } catch {
      // Window API may be unavailable in test environments.
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenResize: (() => void) | null = null;

    void syncMaximizedState();

    try {
      const win = getCurrentWindow();
      void win
        .onResized(() => {
          void syncMaximizedState();
        })
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          unlistenResize = unlisten;
        })
        .catch(() => {
          // Resize listener binding can fail in restricted contexts.
        });
    } catch {
      // Window access can fail in non-Tauri environments.
    }

    return () => {
      disposed = true;
      unlistenResize?.();
    };
  }, [syncMaximizedState]);

  const handleMinimize = useCallback(() => {
    try {
      void getCurrentWindow().minimize();
    } catch {
      // Ignore in non-Tauri environments.
    }
  }, []);

  const handleToggleMaximize = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      await win.toggleMaximize();
      const maximized = await win.isMaximized();
      setIsMaximized(maximized);
    } catch {
      // Ignore in non-Tauri environments.
    }
  }, []);

  const handleClose = useCallback(() => {
    try {
      void getCurrentWindow().close();
    } catch {
      // Ignore in non-Tauri environments.
    }
  }, []);

  const maximizeLabel = isMaximized ? t("common.restore") : t("menu.maximize");

  return (
    <div className="titlebar-toggle titlebar-toggle-right titlebar-window-controls">
      <button
        type="button"
        className="titlebar-window-button"
        onClick={handleMinimize}
        data-tauri-drag-region="false"
        aria-label={t("menu.minimize")}
        title={t("menu.minimize")}
      >
        <span
          className="codicon codicon-chrome-minimize titlebar-window-glyph"
          aria-hidden
        />
      </button>
      <button
        type="button"
        className="titlebar-window-button"
        onClick={() => {
          void handleToggleMaximize();
        }}
        data-tauri-drag-region="false"
        aria-label={maximizeLabel}
        title={maximizeLabel}
      >
        <span
          className={`codicon ${
            isMaximized ? "codicon-chrome-restore" : "codicon-chrome-maximize"
          } titlebar-window-glyph`}
          aria-hidden
        />
      </button>
      <button
        type="button"
        className="titlebar-window-button titlebar-window-button-close"
        onClick={handleClose}
        data-tauri-drag-region="false"
        aria-label={t("menu.closeWindow")}
        title={t("menu.closeWindow")}
      >
        <span
          className="codicon codicon-chrome-close titlebar-window-glyph"
          aria-hidden
        />
      </button>
    </div>
  );
}

export function TitlebarExpandControls(_props: SidebarToggleProps) {
  const isWindowsDesktop = useMemo(() => isWindowsPlatform(), []);

  if (!isWindowsDesktop) {
    return null;
  }

  return (
    <div className="titlebar-controls">
      <WindowControls />
    </div>
  );
}
