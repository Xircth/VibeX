import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type { CodexCustomModel } from "../types";
import { isValidModelId } from "../types";

interface CustomModelDialogProps {
  isOpen: boolean;
  models: CodexCustomModel[];
  onModelsChange: (models: CodexCustomModel[]) => void;
  onClose: () => void;
  initialAddMode?: boolean;
}

function sanitizeInput(value: string): string {
  const filtered = Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      if (code === 9 || code === 10 || code === 13) {
        return true;
      }
      return code >= 32 && code !== 127;
    })
    .join("");
  return filtered.replace(/\s+/g, " ");
}

export function CustomModelDialog({
  isOpen,
  models,
  onModelsChange,
  onClose,
  initialAddMode = false,
}: CustomModelDialogProps) {
  const { t } = useTranslation();
  const [isAdding, setIsAdding] = useState(false);
  const [editingModel, setEditingModel] = useState<CodexCustomModel | null>(
    null,
  );
  const [modelId, setModelId] = useState("");
  const [modelLabel, setModelLabel] = useState("");
  const [modelDescription, setModelDescription] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && initialAddMode) {
      setIsAdding(true);
      setEditingModel(null);
      setModelId("");
      setModelLabel("");
      setModelDescription("");
      setValidationError(null);
    }
  }, [initialAddMode, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setIsAdding(false);
      setEditingModel(null);
      setModelId("");
      setModelLabel("");
      setModelDescription("");
      setValidationError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [isOpen, onClose]);

  const modelIds = useMemo(() => new Set(models.map((item) => item.id)), [models]);

  const validateModelId = useCallback(
    (value: string): string | null => {
      const normalized = value.trim();
      if (!normalized) {
        return t("settings.vendor.modelManager.modelIdRequired");
      }
      if (!isValidModelId(normalized)) {
        return t("settings.vendor.modelManager.modelIdInvalid");
      }

      if (editingModel && editingModel.id === normalized) {
        return null;
      }
      if (modelIds.has(normalized)) {
        return t("settings.vendor.modelManager.modelIdDuplicate");
      }
      return null;
    },
    [editingModel, modelIds, t],
  );

  const resetEditor = useCallback(() => {
    setIsAdding(false);
    setEditingModel(null);
    setModelId("");
    setModelLabel("");
    setModelDescription("");
    setValidationError(null);
  }, []);

  const handleStartAdd = useCallback(() => {
    setIsAdding(true);
    setEditingModel(null);
    setModelId("");
    setModelLabel("");
    setModelDescription("");
    setValidationError(null);
  }, []);

  const handleStartEdit = useCallback((model: CodexCustomModel) => {
    setIsAdding(true);
    setEditingModel(model);
    setModelId(model.id);
    setModelLabel(model.label);
    setModelDescription(model.description ?? "");
    setValidationError(null);
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      onModelsChange(models.filter((model) => model.id !== id));
    },
    [models, onModelsChange],
  );

  const handleSave = useCallback(() => {
    const error = validateModelId(modelId);
    if (error) {
      setValidationError(error);
      return;
    }

    const normalizedId = sanitizeInput(modelId).trim();
    const normalizedLabel = sanitizeInput(modelLabel).trim() || normalizedId;
    const normalizedDescription = sanitizeInput(modelDescription).trim();

    const nextModel: CodexCustomModel = {
      id: normalizedId,
      label: normalizedLabel,
      description: normalizedDescription || undefined,
    };

    if (editingModel) {
      onModelsChange(
        models.map((model) => (model.id === editingModel.id ? nextModel : model)),
      );
    } else {
      onModelsChange([...models, nextModel]);
    }
    resetEditor();
  }, [
    editingModel,
    modelDescription,
    modelId,
    modelLabel,
    models,
    onModelsChange,
    resetEditor,
    validateModelId,
  ]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="vendor-dialog-overlay" onClick={onClose}>
      <div
        className="vendor-dialog vendor-dialog-wide vendor-model-manager-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="vendor-dialog-header">
          <h3>{t("settings.vendor.modelManager.title")}</h3>
          <button
            type="button"
            className="vendor-dialog-close"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            ×
          </button>
        </div>

        <div className="vendor-dialog-body">
          <div className="vendor-hint">{t("settings.vendor.modelManager.description")}</div>

          <div className="vendor-model-manager-list" role="list">
            {models.length === 0 && !isAdding ? (
              <div className="vendor-empty">{t("settings.vendor.modelManager.empty")}</div>
            ) : (
              models.map((model) => (
                <div key={model.id} className="vendor-model-manager-item" role="listitem">
                  <div className="vendor-model-manager-main">
                    <div className="vendor-model-manager-id">{model.id}</div>
                    {model.label !== model.id && (
                      <div className="vendor-model-manager-label">{model.label}</div>
                    )}
                    {model.description && (
                      <div className="vendor-model-manager-desc">{model.description}</div>
                    )}
                  </div>
                  <div className="vendor-model-manager-actions">
                    <button
                      type="button"
                      className="vendor-btn-icon"
                      onClick={() => handleStartEdit(model)}
                      title={t("settings.vendor.edit")}
                    >
                      <Pencil aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="vendor-btn-icon vendor-btn-danger"
                      onClick={() => handleDelete(model.id)}
                      title={t("settings.vendor.delete")}
                    >
                      <Trash2 aria-hidden />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {isAdding ? (
            <div className="vendor-model-manager-form">
              <div className="vendor-model-add">
                <input
                  type="text"
                  className="vendor-input vendor-input-sm"
                  value={modelId}
                  onChange={(event) => {
                    setModelId(event.target.value);
                    if (validationError) {
                      setValidationError(null);
                    }
                  }}
                  placeholder={t("settings.vendor.modelManager.modelIdPlaceholder")}
                  autoFocus
                />
                <input
                  type="text"
                  className="vendor-input vendor-input-sm"
                  value={modelLabel}
                  onChange={(event) => setModelLabel(event.target.value)}
                  placeholder={t("settings.vendor.modelManager.modelLabelPlaceholder")}
                />
              </div>
              <input
                type="text"
                className="vendor-input vendor-input-sm"
                value={modelDescription}
                onChange={(event) => setModelDescription(event.target.value)}
                placeholder={t(
                  "settings.vendor.modelManager.modelDescriptionPlaceholder",
                )}
              />
              {validationError && (
                <div className="vendor-json-error">{validationError}</div>
              )}
              <div className="vendor-model-manager-form-actions">
                <button
                  type="button"
                  className="vendor-btn-cancel"
                  onClick={resetEditor}
                >
                  {t("settings.vendor.cancel")}
                </button>
                <button
                  type="button"
                  className="vendor-btn-save"
                  onClick={handleSave}
                  disabled={!modelId.trim()}
                >
                  {editingModel
                    ? t("settings.vendor.dialog.saveChanges")
                    : t("settings.vendor.modelManager.addModel")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="vendor-btn-save vendor-model-manager-add-btn"
              onClick={handleStartAdd}
            >
              + {t("settings.vendor.modelManager.addModel")}
            </button>
          )}
        </div>

        <div className="vendor-dialog-footer">
          <button type="button" className="vendor-btn-save" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
