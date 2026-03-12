import { useTranslation } from "react-i18next";

type ThreadDeleteConfirmBubbleProps = {
  threadName: string;
  isDeleting?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ThreadDeleteConfirmBubble({
  threadName,
  isDeleting = false,
  onCancel,
  onConfirm,
}: ThreadDeleteConfirmBubbleProps) {
  const { t } = useTranslation();

  return (
    <div
      className="thread-delete-popover"
      role="dialog"
      aria-modal="false"
      aria-label={t("threads.deleteThreadTitle")}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="thread-delete-popover-title">{t("threads.deleteThreadTitle")}</div>
      <div className="thread-delete-popover-message">
        {t("threads.deleteThreadMessage", { name: threadName })}
      </div>
      <div className="thread-delete-popover-hint">{t("threads.deleteThreadHint")}</div>
      <div className="thread-delete-popover-actions">
        <button
          type="button"
          className="thread-delete-popover-button thread-delete-popover-button-secondary"
          onClick={onCancel}
          disabled={isDeleting}
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="thread-delete-popover-button thread-delete-popover-button-danger"
          onClick={onConfirm}
          disabled={isDeleting}
        >
          {isDeleting ? t("common.deleting") : t("threads.delete")}
        </button>
      </div>
    </div>
  );
}
