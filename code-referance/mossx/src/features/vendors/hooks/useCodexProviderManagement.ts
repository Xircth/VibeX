import { useState, useCallback, useEffect } from "react";
import type { CodexProviderConfig } from "../types";
import {
  getCodexProviders,
  addCodexProvider,
  updateCodexProvider,
  deleteCodexProvider,
  switchCodexProvider,
} from "../../../services/tauri";

export interface CodexProviderDialogState {
  isOpen: boolean;
  provider: CodexProviderConfig | null;
}

export interface DeleteCodexConfirmState {
  isOpen: boolean;
  provider: CodexProviderConfig | null;
}

export function useCodexProviderManagement() {
  const [codexProviders, setCodexProviders] = useState<CodexProviderConfig[]>(
    [],
  );
  const [codexLoading, setCodexLoading] = useState(false);

  const [codexProviderDialog, setCodexProviderDialog] =
    useState<CodexProviderDialogState>({
      isOpen: false,
      provider: null,
    });

  const [deleteCodexConfirm, setDeleteCodexConfirm] =
    useState<DeleteCodexConfirmState>({
      isOpen: false,
      provider: null,
    });

  const loadCodexProviders = useCallback(async () => {
    setCodexLoading(true);
    try {
      const list = await getCodexProviders();
      setCodexProviders(list);
    } catch {
      // ignore
    } finally {
      setCodexLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCodexProviders();
  }, [loadCodexProviders]);

  const handleAddCodexProvider = useCallback(() => {
    setCodexProviderDialog({ isOpen: true, provider: null });
  }, []);

  const handleEditCodexProvider = useCallback(
    (provider: CodexProviderConfig) => {
      setCodexProviderDialog({ isOpen: true, provider });
    },
    [],
  );

  const handleCloseCodexProviderDialog = useCallback(() => {
    setCodexProviderDialog({ isOpen: false, provider: null });
  }, []);

  const handleSaveCodexProvider = useCallback(
    async (providerData: CodexProviderConfig) => {
      const isAdding = !codexProviderDialog.provider;

      try {
        if (isAdding) {
          await addCodexProvider(providerData);
        } else {
          await updateCodexProvider(providerData.id, providerData);
        }

        setCodexProviderDialog({ isOpen: false, provider: null });
        await loadCodexProviders();
      } catch {
        // ignore
      }
    },
    [codexProviderDialog.provider, loadCodexProviders],
  );

  const handleSwitchCodexProvider = useCallback(
    async (id: string) => {
      try {
        await switchCodexProvider(id);
        await loadCodexProviders();
      } catch {
        // ignore
      }
    },
    [loadCodexProviders],
  );

  const handleDeleteCodexProvider = useCallback(
    (provider: CodexProviderConfig) => {
      setDeleteCodexConfirm({ isOpen: true, provider });
    },
    [],
  );

  const confirmDeleteCodexProvider = useCallback(async () => {
    const provider = deleteCodexConfirm.provider;
    if (!provider) return;

    try {
      await deleteCodexProvider(provider.id);
      await loadCodexProviders();
    } catch {
      // ignore
    }
    setDeleteCodexConfirm({ isOpen: false, provider: null });
  }, [deleteCodexConfirm.provider, loadCodexProviders]);

  const cancelDeleteCodexProvider = useCallback(() => {
    setDeleteCodexConfirm({ isOpen: false, provider: null });
  }, []);

  return {
    codexProviders,
    codexLoading,
    codexProviderDialog,
    deleteCodexConfirm,
    loadCodexProviders,
    handleAddCodexProvider,
    handleEditCodexProvider,
    handleCloseCodexProviderDialog,
    handleSaveCodexProvider,
    handleSwitchCodexProvider,
    handleDeleteCodexProvider,
    confirmDeleteCodexProvider,
    cancelDeleteCodexProvider,
  };
}

export type UseCodexProviderManagementReturn = ReturnType<
  typeof useCodexProviderManagement
>;
