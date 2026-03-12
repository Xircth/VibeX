import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { TurnPlan } from "../../../types";
import { resolvePlanStepStatusForDisplay } from "../../threads/utils/threadNormalize";

interface PlanListProps {
  plan: TurnPlan | null;
  isPlanMode: boolean;
  isProcessing: boolean;
  isCodexEngine?: boolean;
}

export const PlanList = memo(function PlanList({
  plan,
  isPlanMode,
  isProcessing,
  isCodexEngine = false,
}: PlanListProps) {
  const { t } = useTranslation();
  const steps = plan?.steps ?? [];

  if (!isPlanMode && !isCodexEngine) {
    return <div className="sp-empty">{t("statusPanel.planSwitchHint")}</div>;
  }
  if (isProcessing && steps.length === 0) {
    return <div className="sp-empty">{t("statusPanel.planGenerating")}</div>;
  }
  if (steps.length === 0) {
    return <div className="sp-empty">{t("statusPanel.emptyPlan")}</div>;
  }

  return (
    <ol className="sp-plan-list">
      {steps.map((step, index) => {
        const statusForDisplay = resolvePlanStepStatusForDisplay(step.status, isProcessing);
        return (
          <li key={`${step.step}-${index}`} className={`sp-plan-item sp-plan-${statusForDisplay}`}>
          <span className="sp-plan-status" aria-hidden>
            {statusForDisplay === "completed" ? "✓" : statusForDisplay === "inProgress" ? "…" : "○"}
          </span>
          <span className="sp-plan-text">{step.step}</span>
          </li>
        );
      })}
    </ol>
  );
});
