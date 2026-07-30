import type { CrashReportsInfo } from 'shared/types';

import { backendCall } from './base';

export const crashReportsApi = {
  list(): Promise<CrashReportsInfo> {
    return backendCall<CrashReportsInfo>('crash_reports_list');
  },
  read(id: string): Promise<string> {
    return backendCall<string>('crash_report_read', { id });
  },
  delete(id: string): Promise<void> {
    return backendCall<void>('crash_report_delete', { id });
  },
};
