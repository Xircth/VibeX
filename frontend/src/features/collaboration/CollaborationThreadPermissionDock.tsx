import { useCallback, useMemo, useState } from 'react';
import type { AgentPermissionResponse } from 'shared/types';

import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { useConversationTimeline } from '@/features/conversation/useConversationTimeline';

export function CollaborationThreadPermissionDock({
  conversationId,
}: {
  conversationId: string;
}) {
  const conversation = useConversationTimeline(conversationId, {
    active: true,
  });
  const pending = useMemo(
    () =>
      conversation.sideRows.flatMap((entry) =>
        entry.row.kind === 'permission_request' &&
        entry.row.request.status === 'pending'
          ? [entry.row.request]
          : []
      ),
    [conversation.sideRows]
  );
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const onRespond = useCallback(
    (permissionId: string, response: AgentPermissionResponse) => {
      setRespondingId(permissionId);
      void conversation
        .respondPermission(permissionId, response)
        .finally(() =>
          setRespondingId((current) =>
            current === permissionId ? null : current
          )
        );
    },
    [conversation]
  );
  if (pending.length === 0) return null;
  return (
    <div
      className="collaboration-thread-permission-dock"
      data-testid={`collaboration-thread-permission-dock-${conversationId}`}
    >
      {pending.map((request) => (
        <PermissionRequestCard
          key={`permission-${request.permission_id}`}
          request={request}
          onRespond={onRespond}
          responding={respondingId === request.permission_id}
        />
      ))}
    </div>
  );
}
