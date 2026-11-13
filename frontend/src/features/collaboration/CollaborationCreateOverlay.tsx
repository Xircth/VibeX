import { memo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useCanvasCreationHost } from '@/components/kanban/canvas/canvasCreationHost';
import {
  useCollaborationSpacePick,
  useHasCollaborationSpaceProvider,
} from './space/SpaceContext';

const MESSAGE_AREA_OVERLAY_PICK_KEYS = [
  'agentSelectOptions',
  'chooseConversationLabel',
  'conversationById',
  'conversationSelectOptions',
  'createError',
  'createGroupBots',
  'createMemberError',
  'createMemberOpen',
  'createOpen',
  'draftMemberMetaByConvId',
  'hasActiveOverlay',
  'memberAvatars',
  'memberNicknameByConversationId',
  'memberSourceOptions',
  'newMemberAgentId',
  'newMemberAvatar',
  'newMemberConfigValues',
  'newMemberModeId',
  'newMemberName',
  'newMemberPersonaPrompt',
  'newMemberRoleId',
  'newMemberSessionId',
  'newMemberSource',
  'renderMessageAreaOverlay',
  'roleSelectOptions',
  'roles',
  'selectedSpaceMemberConvIds',
  'spaceName',
  'spaceTagColorId',
  't',
] as const;

interface CollaborationCreateOverlayProps {
  surface?: 'thread' | 'canvas';
  fallback?: ReactNode;
}

const CreateOverlay = memo(function CreateOverlay({
  surface = 'thread',
  fallback = null,
}: CollaborationCreateOverlayProps) {
  const { hasActiveOverlay, renderMessageAreaOverlay } =
    useCollaborationSpacePick(MESSAGE_AREA_OVERLAY_PICK_KEYS);
  const host = useCanvasCreationHost();
  if (surface === 'canvas') return hasActiveOverlay ? null : <>{fallback}</>;
  if (host) return null;
  return <>{renderMessageAreaOverlay() ?? fallback}</>;
});

export const CollaborationCanvasCreateOverlay = memo(
  function CollaborationCanvasCreateOverlay() {
    const host = useCanvasCreationHost();
    const { renderMessageAreaOverlay } = useCollaborationSpacePick(
      MESSAGE_AREA_OVERLAY_PICK_KEYS
    );
    return host ? createPortal(renderMessageAreaOverlay('canvas'), host) : null;
  }
);

export function CollaborationCreateOverlay(
  props: CollaborationCreateOverlayProps
) {
  const hasProvider = useHasCollaborationSpaceProvider();
  return hasProvider ? <CreateOverlay {...props} /> : <>{props.fallback}</>;
}
