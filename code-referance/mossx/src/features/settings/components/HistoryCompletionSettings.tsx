/**
 * History completion management section for the settings page.
 *
 * Provides UI to browse, add, edit, and delete history items
 * used by the inline history completion feature.
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  loadHistoryWithImportance,
  deleteHistoryItem,
  clearAllHistory,
  addHistoryItem,
  updateHistoryItem,
  clearLowImportanceHistory,
  type HistoryItem,
} from "../../composer/hooks/useInputHistoryStore";
import { HistoryItemEditor } from "./HistoryItemEditor";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Plus from "lucide-react/dist/esm/icons/plus";
import Filter from "lucide-react/dist/esm/icons/filter";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import X from "lucide-react/dist/esm/icons/x";
import Inbox from "lucide-react/dist/esm/icons/inbox";

interface EditorState {
  isOpen: boolean;
  mode: "add" | "edit";
  item?: HistoryItem;
}

export function HistoryCompletionSettings() {
  const { t } = useTranslation();
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [showList, setShowList] = useState(false);
  const [editorState, setEditorState] = useState<EditorState>({
    isOpen: false,
    mode: "add",
  });

  const reloadHistory = useCallback(() => {
    try {
      setHistoryItems(loadHistoryWithImportance());
    } catch {
      setHistoryItems([]);
    }
  }, []);

  useEffect(() => {
    if (showList) {
      reloadHistory();
    }
  }, [showList, reloadHistory]);

  const handleDeleteItem = useCallback((item: HistoryItem) => {
    try {
      deleteHistoryItem(item.text);
      setHistoryItems((prev) => prev.filter((i) => i.text !== item.text));
    } catch {
      // ignore
    }
  }, []);

  const handleClearAll = useCallback(() => {
    try {
      clearAllHistory();
      setHistoryItems([]);
    } catch {
      // ignore
    }
  }, []);

  const handleClearLowImportance = useCallback(() => {
    try {
      const deleted = clearLowImportanceHistory(1);
      if (deleted > 0) {
        reloadHistory();
      }
    } catch {
      // ignore
    }
  }, [reloadHistory]);

  const handleSaveEditor = useCallback(
    (text: string, importance: number) => {
      try {
        if (editorState.mode === "add") {
          addHistoryItem(text, importance);
        } else if (editorState.item) {
          updateHistoryItem(editorState.item.text, text, importance);
        }
        reloadHistory();
      } catch {
        // ignore
      }
    },
    [editorState.mode, editorState.item, reloadHistory],
  );

  const lowImportanceCount = historyItems.filter(
    (item) => item.importance <= 1,
  ).length;

  return (
    <>
      <button
        type="button"
        className="history-expand-btn"
        onClick={() => setShowList(!showList)}
      >
        {showList ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{t("settings.historyManageTitle")}</span>
        {historyItems.length > 0 && showList && (
          <span className="history-count-badge">({historyItems.length})</span>
        )}
      </button>

      {showList && (
        <div className="history-list-container">
          {historyItems.length === 0 ? (
            <>
              <div className="history-empty">
                <Inbox size={16} />
                <span>{t("settings.historyManageEmpty")}</span>
              </div>
              <div className="history-list-actions">
                <button
                  type="button"
                  className="history-action-btn"
                  onClick={() =>
                    setEditorState({ isOpen: true, mode: "add" })
                  }
                >
                  <Plus size={12} />
                  <span>{t("settings.historyAdd")}</span>
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="history-list-actions">
                <button
                  type="button"
                  className="history-action-btn"
                  onClick={() =>
                    setEditorState({ isOpen: true, mode: "add" })
                  }
                >
                  <Plus size={12} />
                  <span>{t("settings.historyAdd")}</span>
                </button>
                <div className="history-list-actions-spacer" />
                {lowImportanceCount > 0 && (
                  <button
                    type="button"
                    className="history-action-btn"
                    onClick={handleClearLowImportance}
                  >
                    <Filter size={12} />
                    <span>
                      {t("settings.historyClearLow")} ({lowImportanceCount})
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="history-action-btn history-action-btn--danger"
                  onClick={handleClearAll}
                >
                  <Trash2 size={12} />
                  <span>{t("settings.historyClearAll")}</span>
                </button>
              </div>
              <ul className="history-list">
                {historyItems.map((item, index) => (
                  <li
                    key={`${item.text}-${index}`}
                    className="history-item"
                  >
                    <span
                      className="history-importance-badge"
                      title={t("settings.historyImportance")}
                    >
                      [{item.importance}]
                    </span>
                    <span className="history-item-text" title={item.text}>
                      {item.text}
                    </span>
                    <div className="history-item-actions">
                      <button
                        type="button"
                        className="history-item-btn"
                        onClick={() =>
                          setEditorState({
                            isOpen: true,
                            mode: "edit",
                            item,
                          })
                        }
                        title={t("common.edit")}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        className="history-item-btn history-item-btn--delete"
                        onClick={() => handleDeleteItem(item)}
                        title={t("common.delete")}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <HistoryItemEditor
        isOpen={editorState.isOpen}
        onClose={() => setEditorState((prev) => ({ ...prev, isOpen: false }))}
        onSave={handleSaveEditor}
        mode={editorState.mode}
        initialText={editorState.item?.text}
        initialImportance={editorState.item?.importance}
      />
    </>
  );
}
