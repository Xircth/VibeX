import type { Config } from 'shared/types';
import type { LocalToolStatus, SystemMaintenanceStatus } from '@/lib/api';
import { localToolNeedsUpdatePrompt } from '@/appMaintenancePrompt';

export type AppMaintenanceConfig = Pick<
  Config,
  | 'disclaimer_acknowledged'
  | 'auto_update_enabled'
  | 'auto_install_local_dependencies'
>;

export function shouldStartSystemMaintenance({
  config,
  hasStarted,
}: {
  config: AppMaintenanceConfig | null;
  hasStarted: boolean;
}): boolean {
  if (!config || hasStarted) return false;
  if (!config.disclaimer_acknowledged) return false;
  if (
    config.auto_update_enabled === false &&
    config.auto_install_local_dependencies === false
  ) {
    return false;
  }

  return true;
}

export function shouldShowAppUpdateToast({
  config,
  status,
}: {
  config: AppMaintenanceConfig | null;
  status: SystemMaintenanceStatus;
}): boolean {
  if (!config) return false;

  return config.auto_update_enabled !== false && status.app.update_available;
}

export function getLocalDependencyUpdatePromptTools({
  config,
  tools,
}: {
  config: AppMaintenanceConfig | null;
  tools: LocalToolStatus[];
}): LocalToolStatus[] {
  if (!config) return [];
  if (config.auto_install_local_dependencies === false) return [];

  return tools
    .filter((tool) => tool.user_visible)
    .filter(localToolNeedsUpdatePrompt);
}
