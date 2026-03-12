import { useMemo } from "react";
import type { CollaborationModeOption } from "../../../types";

type UseCollaborationModeSelectionOptions = {
  selectedCollaborationMode: CollaborationModeOption | null;
  selectedCollaborationModeId: string | null;
  selectedEffort: string | null;
  resolvedModel: string | null;
};

export function useCollaborationModeSelection({
  selectedCollaborationMode,
  selectedCollaborationModeId,
  selectedEffort,
  resolvedModel,
}: UseCollaborationModeSelectionOptions) {
  const collaborationModePayload = useMemo(() => {
    if (!selectedCollaborationModeId) {
      return null;
    }

    const modeValue = (
      selectedCollaborationMode?.mode ||
      selectedCollaborationMode?.id ||
      selectedCollaborationModeId
    )
      .trim()
      .toLowerCase();
    const normalizedMode = modeValue === "default" ? "code" : modeValue;
    if (normalizedMode !== "plan" && normalizedMode !== "code") {
      return null;
    }

    const basePayload =
      selectedCollaborationMode?.value &&
      typeof selectedCollaborationMode.value === "object" &&
      !Array.isArray(selectedCollaborationMode.value)
        ? { ...(selectedCollaborationMode.value as Record<string, unknown>) }
        : {};

    const existingSettings = basePayload.settings;
    const settings: Record<string, unknown> =
      existingSettings &&
      typeof existingSettings === "object" &&
      !Array.isArray(existingSettings)
        ? { ...(existingSettings as Record<string, unknown>) }
        : {};

    if (!Object.prototype.hasOwnProperty.call(settings, "developer_instructions")) {
      settings.developer_instructions =
        selectedCollaborationMode?.developerInstructions ?? null;
    }

    if (resolvedModel) {
      settings.model = resolvedModel;
    }

    if (selectedEffort !== null) {
      settings.reasoning_effort = selectedEffort;
    }

    return {
      ...basePayload,
      mode: normalizedMode,
      settings,
    };
  }, [
    resolvedModel,
    selectedCollaborationMode,
    selectedCollaborationModeId,
    selectedEffort,
  ]);

  return { collaborationModePayload };
}
