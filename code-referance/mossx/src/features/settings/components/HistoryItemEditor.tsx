/**
 * Dialog for adding or editing a history completion item.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import Minus from "lucide-react/dist/esm/icons/minus";
import Plus from "lucide-react/dist/esm/icons/plus";
import X from "lucide-react/dist/esm/icons/x";
import Info from "lucide-react/dist/esm/icons/info";

interface HistoryItemEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (text: string, importance: number) => void;
  mode: "add" | "edit";
  initialText?: string;
  initialImportance?: number;
}

export function HistoryItemEditor({
  isOpen,
  onClose,
  onSave,
  mode,
  initialText = "",
  initialImportance = 1,
}: HistoryItemEditorProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const [importance, setImportance] = useState(initialImportance);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      setText(initialText);
      setImportance(initialImportance);
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
    }
  }, [isOpen, initialText, initialImportance]);

  const handleSave = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSave(trimmed, importance);
    onClose();
  }, [text, importance, onSave, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        handleSave();
      }
    },
    [onClose, handleSave],
  );

  if (!isOpen) return null;

  const title =
    mode === "add"
      ? t("settings.historyEditorAddTitle")
      : t("settings.historyEditorEditTitle");

  return (
    <div className="history-editor-overlay" onClick={onClose}>
      <div
        className="history-editor-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="history-editor-header">
          <h4 className="history-editor-title">{title}</h4>
          <button
            type="button"
            className="history-editor-close"
            onClick={onClose}
            title={t("common.close")}
          >
            <X size={14} />
          </button>
        </div>

        <div>
          <div className="history-editor-field">
            <label className="history-editor-label">
              {t("settings.historyEditorContent")}
            </label>
            <textarea
              ref={textareaRef}
              className="history-editor-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("settings.historyEditorContentPlaceholder")}
              rows={3}
            />
          </div>

          <div className="history-editor-field">
            <label className="history-editor-label">
              {t("settings.historyEditorImportance")}
            </label>
            <div className="history-editor-importance">
              <button
                type="button"
                className="history-editor-importance-btn"
                onClick={() => setImportance((prev) => Math.max(1, prev - 1))}
                disabled={importance <= 1}
              >
                <Minus size={14} />
              </button>
              <input
                type="number"
                className="history-editor-importance-input"
                value={importance}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10);
                  if (!isNaN(value) && value >= 1) {
                    setImportance(value);
                  }
                }}
                min={1}
              />
              <button
                type="button"
                className="history-editor-importance-btn"
                onClick={() => setImportance((prev) => prev + 1)}
              >
                <Plus size={14} />
              </button>
            </div>
            <div className="history-editor-hint">
              <Info size={12} />
              <span>{t("settings.historyEditorImportanceHint")}</span>
            </div>
          </div>
        </div>

        <div className="history-editor-footer">
          <button
            type="button"
            className="history-editor-btn"
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="history-editor-btn history-editor-btn--primary"
            onClick={handleSave}
            disabled={!text.trim()}
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
