import { SpaceMessageBody } from '../SpaceMessageBody';
import { useCollaborationSpace } from './SpaceContext';

export function DirectMessages() {
  const {
    activeDirectThreadId,
    pendingDirectMessages,
    selected,
    workspace,
    workspacePath,
  } = useCollaborationSpace();

  if (!selected) return null;

  return (
    <>
      {pendingDirectMessages
        .filter(
          (item) =>
            item.threadId === (activeDirectThreadId || selected.space_id)
        )
        .map((item) => (
          <article
            key={`pending-${item.operationId}`}
            className="collaboration-message"
            data-pending="true"
            data-testid={`collaboration-pending-message-${item.operationId}`}
          >
            <SpaceMessageBody
              fromYou
              text={item.content}
              workspacePath={workspacePath}
              workspaceId={workspace || undefined}
              deliveryStatus="sent"
              deliveryTickTestId="collaboration-pending-tick"
            />
          </article>
        ))}
    </>
  );
}
