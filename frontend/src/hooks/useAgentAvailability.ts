import { useCallback, useEffect, useState } from 'react';
import type { AgentId } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';

export type AgentAvailabilityState =
  | { status: 'checking' }
  | { status: 'login_detected' }
  | { status: 'installation_found' }
  | { status: 'not_found' }
  | null;

export interface AgentAvailability {
  availability: AgentAvailabilityState;
  recheck: () => void;
}

export function useAgentAvailability(
  agent: AgentId | null | undefined
): AgentAvailability {
  const [availability, setAvailability] =
    useState<AgentAvailabilityState>(null);
  const [probeToken, setProbeToken] = useState(0);

  useEffect(() => {
    if (!agent) {
      setAvailability(null);
      return;
    }

    let active = true;
    setAvailability({ status: 'checking' });
    void agentManagementApi
      .detail(agent)
      .then((view) => {
        if (!active) return;
        if (view.lifecycle === 'ready') {
          setAvailability(
            view.authentication === 'not_logged_in'
              ? { status: 'installation_found' }
              : { status: 'login_detected' }
          );
        } else if (
          view.lifecycle === 'needs_auth' ||
          view.runtime_version ||
          view.acp_version
        ) {
          setAvailability({ status: 'installation_found' });
        } else {
          setAvailability({ status: 'not_found' });
        }
      })
      .catch(() => {
        if (active) setAvailability({ status: 'not_found' });
      });

    return () => {
      active = false;
    };
  }, [agent, probeToken]);

  const recheck = useCallback(() => {
    setProbeToken((token) => token + 1);
  }, []);

  return { availability, recheck };
}
