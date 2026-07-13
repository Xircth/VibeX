import type { CrashReportsInfo } from 'shared/types';

import { tauriInvoke } from './base';

export const crashReportsApi = {
  list(): Promise<CrashReportsInfo> {
    return tauriInvoke<CrashReportsInfo>('crash_reports_list');
  },
  read(id: string): Promise<string> {
    return tauriInvoke<string>('crash_report_read', { id });
  },
  delete(id: string): Promise<void> {
    return tauriInvoke<void>('crash_report_delete', { id });
  },
};
