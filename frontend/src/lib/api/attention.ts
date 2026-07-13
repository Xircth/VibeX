import type { AttentionInbox } from 'shared/types';

import { tauriInvoke } from './base';

export const attentionApi = {
  list(): Promise<AttentionInbox> {
    return tauriInvoke<AttentionInbox>('attention_inbox_list');
  },
};
