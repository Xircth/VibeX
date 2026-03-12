import type { AppSettings, OpenAppTarget } from "../../../types";
import { DEFAULT_OPEN_APP_ID } from "../constants";
import { getClientStoreSync } from "../../../services/clientStorage";

export function normalizeOpenAppTargets(targets: OpenAppTarget[]): OpenAppTarget[] {
  return targets
    .map((target) => ({
      ...target,
      label: target.label.trim(),
      appName: (target.appName?.trim() ?? "") || null,
      command: (target.command?.trim() ?? "") || null,
      args: Array.isArray(target.args) ? target.args.map((arg) => arg.trim()) : [],
    }))
    .filter((target) => target.label && target.id);
}

export function getOpenAppTargets(settings: AppSettings): OpenAppTarget[] {
  return normalizeOpenAppTargets(settings.openAppTargets ?? []);
}

export function getSelectedOpenAppId(settings: AppSettings): string {
  const targets = getOpenAppTargets(settings);
  const selected =
    settings.selectedOpenAppId ||
    getClientStoreSync<string>("app", "openWorkspaceApp") ||
    DEFAULT_OPEN_APP_ID;
  return targets.some((target) => target.id === selected)
    ? selected
    : targets[0]?.id ?? DEFAULT_OPEN_APP_ID;
}
