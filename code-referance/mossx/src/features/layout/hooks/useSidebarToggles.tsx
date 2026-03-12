import { useEffect, useState } from "react";
import { getClientStoreSync, writeClientStoreValue } from "../../../services/clientStorage";

type UseSidebarTogglesOptions = {
  isCompact: boolean;
};

function readStoredBool(key: string, defaultValue = false) {
  const stored = getClientStoreSync<boolean>("layout", key);
  if (stored === undefined) {
    return defaultValue;
  }
  return stored;
}

export function useSidebarToggles({ isCompact }: UseSidebarTogglesOptions) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readStoredBool("sidebarCollapsed"),
  );
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(() =>
    readStoredBool("rightPanelCollapsed", true),
  );

  useEffect(() => {
    writeClientStoreValue("layout", "sidebarCollapsed", sidebarCollapsed);
  }, [sidebarCollapsed]);

  useEffect(() => {
    writeClientStoreValue("layout", "rightPanelCollapsed", rightPanelCollapsed);
  }, [rightPanelCollapsed]);

  const collapseSidebar = () => {
    if (!isCompact) {
      setSidebarCollapsed(true);
    }
  };

  const expandSidebar = () => {
    if (!isCompact) {
      setSidebarCollapsed(false);
    }
  };

  const collapseRightPanel = () => {
    if (!isCompact) {
      setRightPanelCollapsed(true);
    }
  };

  const expandRightPanel = () => {
    if (!isCompact) {
      setRightPanelCollapsed(false);
    }
  };

  return {
    sidebarCollapsed,
    rightPanelCollapsed,
    collapseSidebar,
    expandSidebar,
    collapseRightPanel,
    expandRightPanel,
  };
}
