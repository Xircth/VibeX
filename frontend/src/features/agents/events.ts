import { backendListen } from '@/lib/backendTransport';
import type { AgentEventEnvelope } from './types';

export const AGENT_EVENTS_CHANNEL = 'agent-events';

export function listenToAgentEvents(
  onEvent: (event: AgentEventEnvelope) => void
): Promise<() => void> {
  return backendListen<AgentEventEnvelope>(AGENT_EVENTS_CHANNEL, onEvent);
}
