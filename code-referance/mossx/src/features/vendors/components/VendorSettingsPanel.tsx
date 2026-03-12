import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import PackagePlus from "lucide-react/dist/esm/icons/package-plus";
import type { CodexCustomModel, CodexProviderConfig, VendorTab } from "../types";
import { STORAGE_KEYS, validateCodexCustomModels } from "../types";
import { useProviderManagement } from "../hooks/useProviderManagement";
import { useCodexProviderManagement } from "../hooks/useCodexProviderManagement";
import { usePluginModels } from "../hooks/usePluginModels";
import { ProviderList } from "./ProviderList";
import { CodexProviderList } from "./CodexProviderList";
import { ProviderDialog } from "./ProviderDialog";
import { CodexProviderDialog } from "./CodexProviderDialog";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { CustomModelDialog } from "./CustomModelDialog";
import { CurrentClaudeConfigCard } from "./CurrentClaudeConfigCard";
import {
  consumeVendorModelManagerRequest,
  VENDOR_MODEL_MANAGER_REQUEST_EVENT,
} from "../modelManagerRequest";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

const LEGACY_CLAUDE_MAPPING_KEYS = [
  "mossx-claude-model-mapping",
  "codemoss-claude-model-mapping",
];
const CODEX_PLUGIN_MODELS_MIGRATION_MARKER =
  "codemoss-codex-plugin-models-migrated-v1";

function collectProviderCustomModels(
  providers: CodexProviderConfig[],
): CodexCustomModel[] {
  const merged: CodexCustomModel[] = [];
  const seenIds = new Set<string>();

  for (const provider of providers) {
    const models = validateCodexCustomModels(provider.customModels ?? []);
    for (const model of models) {
      const id = model.id.trim();
      if (!id || seenIds.has(id)) {
        continue;
      }
      seenIds.add(id);
      const label = model.label?.trim() || id;
      const description = model.description?.trim();
      merged.push({
        id,
        label,
        description: description && description.length > 0 ? description : undefined,
      });
    }
  }

  return merged;
}

export function VendorSettingsPanel() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<VendorTab>("claude");
  const [dialogTarget, setDialogTarget] = useState<VendorTab>("claude");
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [modelDialogAddMode, setModelDialogAddMode] = useState(false);
  const didRunLegacyMigrationRef = useRef(false);
  const didSeedCodexPluginModelsRef = useRef(false);

  const claude = useProviderManagement();
  const codex = useCodexProviderManagement();
  const claudeModels = usePluginModels(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS);
  const codexModels = usePluginModels(STORAGE_KEYS.CODEX_CUSTOM_MODELS);

  const openModelDialog = useCallback((target: VendorTab, addMode = false) => {
    setDialogTarget(target);
    setModelDialogAddMode(addMode);
    setModelDialogOpen(true);
  }, []);

  const closeModelDialog = useCallback(() => {
    setModelDialogOpen(false);
    setModelDialogAddMode(false);
  }, []);

  const applyPendingModelManagerRequest = useCallback(() => {
    const request = consumeVendorModelManagerRequest();
    if (!request) {
      return;
    }
    const target: VendorTab = request.target === "codex" ? "codex" : "claude";
    setActiveTab(target);
    openModelDialog(target, Boolean(request.addMode));
  }, [openModelDialog]);

  useEffect(() => {
    applyPendingModelManagerRequest();
    const handleRequest = () => applyPendingModelManagerRequest();
    window.addEventListener(VENDOR_MODEL_MANAGER_REQUEST_EVENT, handleRequest);
    return () => {
      window.removeEventListener(
        VENDOR_MODEL_MANAGER_REQUEST_EVENT,
        handleRequest,
      );
    };
  }, [applyPendingModelManagerRequest]);

  useEffect(() => {
    if (didRunLegacyMigrationRef.current) {
      return;
    }
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    const canonicalKey = STORAGE_KEYS.CLAUDE_MODEL_MAPPING;
    const hasCanonical = Boolean(window.localStorage.getItem(canonicalKey));
    if (hasCanonical) {
      didRunLegacyMigrationRef.current = true;
      return;
    }

    for (const legacyKey of LEGACY_CLAUDE_MAPPING_KEYS) {
      const value = window.localStorage.getItem(legacyKey);
      if (!value) {
        continue;
      }
      try {
        window.localStorage.setItem(canonicalKey, value);
        window.dispatchEvent(
          new CustomEvent("localStorageChange", {
            detail: { key: canonicalKey },
          }),
        );
      } catch {
        // ignore migration write errors
      }
      break;
    }
    didRunLegacyMigrationRef.current = true;
  }, []);

  useEffect(() => {
    if (didSeedCodexPluginModelsRef.current) {
      return;
    }
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    const alreadyMigrated =
      window.localStorage.getItem(CODEX_PLUGIN_MODELS_MIGRATION_MARKER) === "1";
    if (alreadyMigrated) {
      didSeedCodexPluginModelsRef.current = true;
      return;
    }
    if (codexModels.models.length > 0) {
      try {
        window.localStorage.setItem(CODEX_PLUGIN_MODELS_MIGRATION_MARKER, "1");
      } catch {
        // ignore marker write errors
      }
      didSeedCodexPluginModelsRef.current = true;
      return;
    }
    if (codex.codexProviders.length === 0) {
      return;
    }

    const fallbackModels = collectProviderCustomModels(codex.codexProviders);
    if (fallbackModels.length === 0) {
      try {
        window.localStorage.setItem(CODEX_PLUGIN_MODELS_MIGRATION_MARKER, "1");
      } catch {
        // ignore marker write errors
      }
      didSeedCodexPluginModelsRef.current = true;
      return;
    }

    codexModels.updateModels(fallbackModels);
    try {
      window.localStorage.setItem(CODEX_PLUGIN_MODELS_MIGRATION_MARKER, "1");
    } catch {
      // ignore marker write errors
    }
    didSeedCodexPluginModelsRef.current = true;
  }, [codex.codexProviders, codexModels.models.length, codexModels.updateModels]);

  const currentDialogModels =
    dialogTarget === "codex" ? codexModels.models : claudeModels.models;

  const handleDialogModelsChange = useCallback(
    (models: CodexCustomModel[]) => {
      if (dialogTarget === "codex") {
        codexModels.updateModels(models);
        return;
      }
      claudeModels.updateModels(models);
    },
    [claudeModels, codexModels, dialogTarget],
  );

  return (
    <div className="vendor-settings-panel">
      <h3 className="vendor-section-title">{t("settings.vendorsTitle")}</h3>
      <p className="vendor-section-desc">{t("settings.vendorsDescription")}</p>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as VendorTab)}
      >
        <TabsList className="vendor-tabs">
          <TabsTab className="vendor-tab" value="claude">
            Claude Code
          </TabsTab>
          <TabsTab className="vendor-tab" value="codex">
            Codex
          </TabsTab>
        </TabsList>

        <TabsPanel value="claude">
          <div className="vendor-tab-content">
            <div
              className="vendor-plugin-model-entry"
              role="button"
              tabIndex={0}
              onClick={() => openModelDialog("claude")}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openModelDialog("claude");
                }
              }}
            >
              <div className="vendor-plugin-model-entry-main">
                <PackagePlus size={16} />
                <span className="vendor-plugin-model-entry-title">
                  {t("settings.vendor.pluginModels")}
                </span>
                {claudeModels.models.length > 0 && (
                  <span className="vendor-plugin-model-entry-count">
                    {claudeModels.models.length}
                  </span>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={(event) => {
                  event.stopPropagation();
                  openModelDialog("claude");
                }}
              >
                {t("settings.vendor.manageModels")}
              </Button>
            </div>
            <CurrentClaudeConfigCard
              config={claude.currentConfig}
              loading={claude.currentConfigLoading}
              providers={claude.providers}
              onSwitchProvider={claude.handleSwitchProvider}
            />
            <ProviderList
              providers={claude.providers}
              loading={claude.loading}
              onAdd={claude.handleAddProvider}
              onEdit={claude.handleEditProvider}
              onDelete={claude.handleDeleteProvider}
              onSwitch={claude.handleSwitchProvider}
            />
            <ProviderDialog
              isOpen={claude.providerDialog.isOpen}
              provider={claude.providerDialog.provider}
              onClose={claude.handleCloseProviderDialog}
              onSave={claude.handleSaveProvider}
            />
            <DeleteConfirmDialog
              isOpen={claude.deleteConfirm.isOpen}
              providerName={claude.deleteConfirm.provider?.name ?? ""}
              onConfirm={claude.confirmDeleteProvider}
              onCancel={claude.cancelDeleteProvider}
            />
          </div>
        </TabsPanel>

        <TabsPanel value="codex">
          <div className="vendor-tab-content">
            <div
              className="vendor-plugin-model-entry"
              role="button"
              tabIndex={0}
              onClick={() => openModelDialog("codex")}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openModelDialog("codex");
                }
              }}
            >
              <div className="vendor-plugin-model-entry-main">
                <PackagePlus size={16} />
                <span className="vendor-plugin-model-entry-title">
                  {t("settings.vendor.pluginModels")}
                </span>
                {codexModels.models.length > 0 && (
                  <span className="vendor-plugin-model-entry-count">
                    {codexModels.models.length}
                  </span>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={(event) => {
                  event.stopPropagation();
                  openModelDialog("codex");
                }}
              >
                {t("settings.vendor.manageModels")}
              </Button>
            </div>
            <CodexProviderList
              providers={codex.codexProviders}
              loading={codex.codexLoading}
              onAdd={codex.handleAddCodexProvider}
              onEdit={codex.handleEditCodexProvider}
              onDelete={codex.handleDeleteCodexProvider}
              onSwitch={codex.handleSwitchCodexProvider}
            />
            <CodexProviderDialog
              isOpen={codex.codexProviderDialog.isOpen}
              provider={codex.codexProviderDialog.provider}
              onClose={codex.handleCloseCodexProviderDialog}
              onSave={codex.handleSaveCodexProvider}
            />
            <DeleteConfirmDialog
              isOpen={codex.deleteCodexConfirm.isOpen}
              providerName={codex.deleteCodexConfirm.provider?.name ?? ""}
              onConfirm={codex.confirmDeleteCodexProvider}
              onCancel={codex.cancelDeleteCodexProvider}
            />
          </div>
        </TabsPanel>
      </Tabs>

      <CustomModelDialog
        isOpen={modelDialogOpen}
        models={currentDialogModels}
        onModelsChange={handleDialogModelsChange}
        onClose={closeModelDialog}
        initialAddMode={modelDialogAddMode}
      />
    </div>
  );
}
