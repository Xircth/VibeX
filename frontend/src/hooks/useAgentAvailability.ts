import { useCallback, useEffect, useState } from 'react';
import { AgentKind } from 'shared/types';
import { configApi } from '../lib/api';

export type AgentAvailabilityState =
  | { status: 'checking' }
  | { status: 'login_detected' }
  | { status: 'installation_found' }
  | { status: 'not_found' }
  | null;

export interface AgentAvailability {
  availability: AgentAvailabilityState;
  /** Re-run the availability probe (e.g. after a quick fix was applied). */
  recheck: () => void;
}

export function useAgentAvailability(
  agent: AgentKind | null | undefined
): AgentAvailability {
  const [availability, setAvailability] =
    useState<AgentAvailabilityState>(null);
  const [probeToken, setProbeToken] = useState(0);

  useEffect(() => {
    if (!agent) {
      setAvailability(null);
      return;
    }

    let cancelled = false;
    const checkAvailability = async () => {
      setAvailability({ status: 'checking' });
      try {
        const info = await configApi.checkAgentAvailability(agent);
        if (cancelled) return;

        // Map backend enum to frontend state
        switch (info.type) {
          case 'LOGIN_DETECTED':
            setAvailability({ status: 'login_detected' });
            break;
          case 'INSTALLATION_FOUND':
            setAvailability({ status: 'installation_found' });
            break;
          case 'NOT_FOUND':
            setAvailability({ status: 'not_found' });
            break;
        }
      } catch (error) {
        console.error('Failed to check agent availability:', error);
        if (!cancelled) setAvailability(null);
      }
    };

    void checkAvailability();
    return () => {
      cancelled = true;
    };
  }, [agent, probeToken]);

  const recheck = useCallback(() => {
    setProbeToken((token) => token + 1);
  }, []);

  return { availability, recheck };
}
