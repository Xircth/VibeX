import { useTranslation } from "react-i18next";
import type { TurnPlan } from "../../../types";
import { resolvePlanStepStatusForDisplay } from "../../threads/utils/threadNormalize";

type PlanPanelProps = {
  plan: TurnPlan | null;
  isProcessing: boolean;
  isPlanMode: boolean;
  isCodexEngine?: boolean;
  onClose?: () => void;
};

function formatProgress(plan: TurnPlan) {
  const total = plan.steps.length;
  if (!total) {
    return "";
  }
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  return `${completed}/${total}`;
}

function statusLabel(status: TurnPlan["steps"][number]["status"]) {
  if (status === "completed") {
    return "[x]";
  }
  if (status === "inProgress") {
    return "[>]";
  }
  return "[ ]";
}

export function PlanPanel({
  plan,
  isProcessing,
  isPlanMode,
  isCodexEngine = false,
  onClose,
}: PlanPanelProps) {
  const { t } = useTranslation();
  const progress = plan ? formatProgress(plan) : "";
  const steps = plan?.steps ?? [];
  const showEmpty = !steps.length && !plan?.explanation;
  const noPlanLabel = t("plan.noPlan");
  const emptyLabel = !isPlanMode && !isCodexEngine
    ? t("statusPanel.planSwitchHint")
    : isProcessing
      ? t("statusPanel.planGenerating")
      : noPlanLabel === "plan.noPlan"
        ? t("statusPanel.emptyPlan")
        : noPlanLabel;

  return (
    <aside className="plan-panel">
      <div className="plan-header">
        <span>{t("plan.title")}</span>
        <div className="plan-header-actions">
          {progress && <span className="plan-progress">{progress}</span>}
          {onClose && (
            <button
              type="button"
              className="plan-toggle-btn"
              onClick={onClose}
              aria-label={t("tools.closePlanPanel")}
              title={t("tools.closePlanPanel")}
            >
              <span className="plan-toggle-thumb" aria-hidden />
            </button>
          )}
        </div>
      </div>
      {plan?.explanation && (
        <div className="plan-explanation">{plan.explanation}</div>
      )}
      {showEmpty ? (
        <div className="plan-empty">{emptyLabel}</div>
      ) : (
        <ol className="plan-list">
          {steps.map((step, index) => (
            <li
              key={`${step.step}-${index}`}
              className={`plan-step ${resolvePlanStepStatusForDisplay(step.status, isProcessing)}`}
            >
              <span className="plan-step-status" aria-hidden>
                {statusLabel(resolvePlanStepStatusForDisplay(step.status, isProcessing))}
              </span>
              <span className="plan-step-text">{step.step}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
