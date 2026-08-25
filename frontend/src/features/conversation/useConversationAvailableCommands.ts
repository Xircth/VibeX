import { useEffect, useState } from 'react';
import type { AgentAvailableCommand } from 'shared/types';
import { conversationApi } from './conversationApi';
import { listenToConversationEvents } from './events';

export function useConversationAvailableCommands(
  conversationId: string | null | undefined
): {
  commands: AgentAvailableCommand[] | null;
  loading: boolean;
} {
  const [commands, setCommands] = useState<AgentAvailableCommand[] | null>(
    null
  );

  useEffect(() => {
    setCommands(null);
    if (!conversationId) return;
    let active = true;

    void conversationApi
      .detail(conversationId)
      .then((detail) => {
        if (!active) return;
        if (
          detail?.available_commands !== undefined &&
          detail.available_commands !== null
        ) {
          setCommands(detail.available_commands);
        }
      })
      .catch(() => undefined);

    const unlisten = listenToConversationEvents((batch) => {
      if (!active || batch.conversation_id !== conversationId) return;
      if (batch.available_commands) {
        setCommands(batch.available_commands);
      }
    });

    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, [conversationId]);

  return {
    commands,
    loading: Boolean(conversationId) && commands === null,
  };
}
