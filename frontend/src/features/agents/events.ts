import { tauriListen } from '@/lib/tauriApi';
import type { AgentEventEnvelope } from './types';

export const AGENT_EVENTS_CHANNEL = 'agent-events';

export function listenToAgentEvents(
  onEvent: (event: AgentEventEnvelope) => void
): Promise<() => void> {
  return tauriListen<AgentEventEnvelope>(AGENT_EVENTS_CHANNEL, onEvent);
}
