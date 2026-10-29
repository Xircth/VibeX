import { useTranslation } from 'react-i18next';

import type { AgentModelProviderManagerProps } from './types';
import { useProviderActions } from './useProviderActions';
import { useProviderFormActions } from './useProviderFormActions';
import { useProviderFormState } from './useProviderFormState';

export function useAgentModelProviderManager({
  agentId,
  disabled,
  onDirtyChange,
  onChanged,
  embedded = false,
  signedIn = false,
  active = true,
}: AgentModelProviderManagerProps) {
  const { t } = useTranslation(['settings', 'common']);
  const state = useProviderFormState({
    agentId,
    onDirtyChange,
    active,
    embedded,
  });
  const formActions = useProviderFormActions(state, {
    agentId,
    onChanged,
  });
  const listActions = useProviderActions(state, {
    agentId,
    signedIn,
    onChanged,
  });
  const providers = state.view?.providers ?? [];
  const busy = disabled || state.saving;

  return {
    t,
    ...state,
    ...formActions,
    ...listActions,
    providers,
    busy,
    agentId,
  };
}
