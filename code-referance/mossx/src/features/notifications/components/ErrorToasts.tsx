import { useTranslation } from "react-i18next";
import type { ErrorToast } from "../../../services/toasts";

type ErrorToastsProps = {
  toasts: ErrorToast[];
  onDismiss: (id: string) => void;
};

export function ErrorToasts({ toasts, onDismiss }: ErrorToastsProps) {
  const { t } = useTranslation();
  if (!toasts.length) {
    return null;
  }

  return (
    <div className="error-toasts" role="region" aria-live="assertive">
      {toasts.map((toast) => (
        <div key={toast.id} className="error-toast" role="alert">
          <div className="error-toast-header">
            <div className="error-toast-title">{toast.title}</div>
            <button
              type="button"
              className="ghost error-toast-dismiss"
              onClick={() => onDismiss(toast.id)}
              aria-label={t("errors.dismissError")}
              title={t("common.dismiss")}
            >
              ×
            </button>
          </div>
          <div className="error-toast-body">{toast.message}</div>
        </div>
      ))}
    </div>
  );
}

