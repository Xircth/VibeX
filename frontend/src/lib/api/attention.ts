import type { AttentionInbox } from 'shared/types';

import { backendCall } from './base';

export const attentionApi = {
  list(): Promise<AttentionInbox> {
    return backendCall<AttentionInbox>('attention_inbox_list');
  },
};
