import { tauriInvoke } from '@/lib/tauriApi';
import type { Automation, AutomationInput, AutomationRun } from 'shared/types';

export const automationApi = {
  list: (): Promise<Automation[]> => tauriInvoke('automation_list'),

  create: (input: AutomationInput): Promise<Automation> =>
    tauriInvoke('automation_create', { input }),

  update: (id: string, input: AutomationInput): Promise<Automation> =>
    tauriInvoke('automation_update', { id, input }),

  setEnabled: (id: string, enabled: boolean): Promise<void> =>
    tauriInvoke('automation_set_enabled', { id, enabled }),

  remove: (id: string): Promise<void> =>
    tauriInvoke('automation_delete', { id }),

  runNow: (id: string): Promise<AutomationRun> =>
    tauriInvoke('automation_run_now', { id }),

  runs: (automationId: string, limit?: number): Promise<AutomationRun[]> =>
    tauriInvoke('automation_runs', { automationId, limit: limit ?? null }),

  unseenFailures: (): Promise<number> =>
    tauriInvoke('automation_unseen_failures'),

  markSeen: (): Promise<void> => tauriInvoke('automation_mark_seen'),
};
