import { memo, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { DockviewReact } from 'dockview-react';
import { ChevronDown } from 'lucide-react';

import { useCanvasPanelHeaderSlot } from '@/components/kanban/canvas/CanvasPanelHeaderSlotContext';
import { WorkspaceTabAddMenu } from '@/components/layout/panels/WorkspaceTabAddMenu';
import { cn } from '@/lib/utils';
import i18n from '@/i18n';

import { COPY, displayName } from './spaceModel';
import { MemberBotAvatar } from './MemberBotAvatar';
import { GroupAvatar } from './GroupAvatar';
import {
  COLLABORATION_PREVIEW_COMPONENTS,
  CollaborationPreviewDockviewTab,
  CollaborationPreviewHeaderActions,
  CollaborationPreviewScope,
} from './CollaborationPreviewDockview';
import { CollaborationGlobalSearchModal } from './CollaborationGlobalSearchModal';
import { CollaborationMemberMentionContext } from './MemberMentionChip';
import './collaboration.css';
import {
  CollaborationSpaceProvider,
  useCollaborationSpacePick,
} from './space/SpaceContext';
import { GroupListPanel } from './space/GroupListPanel';
import { MemberPanel } from './space/MemberPanel';
import { MessageStream } from './space/MessageStream';
import { ComposerDock } from './space/ComposerDock';

if (
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver ===
    'undefined'
) {
  class FallbackResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (
    globalThis as unknown as {
      ResizeObserver: typeof FallbackResizeObserver;
    }
  ).ResizeObserver = FallbackResizeObserver;
}

export function CollaborationSpacePage({
  workspaceId,
}: {
  workspaceId: string | null;
}) {
  return (
    <CollaborationSpaceProvider workspaceId={workspaceId}>
      <CollaborationSpaceLayout />
    </CollaborationSpaceProvider>
  );
}

const BACK_TO_BOTTOM_PICK_KEYS = [
  'isAtThreadBottom',
  'pinThreadLogToBottom',
  'selected',
] as const;

const CollaborationBackToBottomButton = memo(
  function CollaborationBackToBottomButton() {
    const { isAtThreadBottom, pinThreadLogToBottom, selected } =
      useCollaborationSpacePick(BACK_TO_BOTTOM_PICK_KEYS);

    if (!selected || isAtThreadBottom) return null;

    return (
      <div className="collaboration-back-to-bottom">
        <button
          type="button"
          className="tahoe-popover collaboration-back-to-bottom-btn"
          data-testid="collaboration-back-to-bottom"
          aria-label={COPY.backToBottom}
          title={COPY.backToBottom}
          onClick={() => pinThreadLogToBottom('smooth')}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    );
  }
);

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

const CollaborationMessageAreaOverlay = memo(
  function CollaborationMessageAreaOverlay() {
    const { renderMessageAreaOverlay } = useCollaborationSpacePick(
      MESSAGE_AREA_OVERLAY_PICK_KEYS
    );
    return <>{renderMessageAreaOverlay()}</>;
  }
);

const DRAG_GHOST_PICK_KEYS = [
  'draggingMember',
  'draggingThreadName',
  'getMemberAvatar',
  'memberAvatars',
  'pointerDragCursor',
] as const;

export const CollaborationDragGhost = memo(function CollaborationDragGhost() {
  const {
    draggingMember,
    draggingThreadName,
    getMemberAvatar,
    pointerDragCursor,
  } = useCollaborationSpacePick(DRAG_GHOST_PICK_KEYS);

  if (!pointerDragCursor) return null;

  return (
    <>
      {draggingMember ? (
        <div
          className="collaboration-member-drag-ghost"
          data-testid="collaboration-member-drag-ghost"
          style={{
            left: `${pointerDragCursor.x + 12}px`,
            top: `${pointerDragCursor.y + 12}px`,
          }}
        >
          <MemberBotAvatar
            config={getMemberAvatar(
              draggingMember.conversationId,
              draggingMember.nickname
            )}
            className="h-3.5 w-3.5 shrink-0"
          />
          <span>{draggingMember.nickname}</span>
        </div>
      ) : null}
      {draggingThreadName ? (
        <div
          className="collaboration-member-drag-ghost"
          data-testid="collaboration-thread-drag-ghost"
          style={{
            left: `${pointerDragCursor.x + 12}px`,
            top: `${pointerDragCursor.y + 12}px`,
          }}
        >
          <span>{draggingThreadName}</span>
        </div>
      ) : null}
    </>
  );
});

const GLOBAL_SEARCH_PICK_KEYS = [
  'getMemberAvatar',
  'globalSearchResults',
  'memberAvatars',
  'openPrivateChat',
  'searchOpen',
  'searchQuery',
  'selectSpace',
  'setSearchOpen',
  'setSearchQuery',
] as const;

const CollaborationGlobalSearchOverlay = memo(
  function CollaborationGlobalSearchOverlay() {
    const {
      getMemberAvatar,
      globalSearchResults,
      openPrivateChat,
      searchOpen,
      searchQuery,
      selectSpace,
      setSearchOpen,
      setSearchQuery,
    } = useCollaborationSpacePick(GLOBAL_SEARCH_PICK_KEYS);

    if (!searchOpen) return null;

    return (
      <CollaborationGlobalSearchModal
        query={searchQuery}
        onQueryChange={setSearchQuery}
        onClose={() => {
          setSearchOpen(false);
          setSearchQuery('');
        }}
        empty={globalSearchResults.length === 0}
      >
        {globalSearchResults.map((item) =>
          item.kind === 'member' ? (
            <button
              key={item.key}
              type="button"
              data-testid={`collaboration-global-search-item-${item.name}`}
              className="collaboration-global-search-item"
              onClick={() => {
                setSearchOpen(false);
                setSearchQuery('');
                openPrivateChat(item.spaceId, item.member, item.threadId);
              }}
            >
              <span className="collaboration-global-search-avatar">
                <MemberBotAvatar
                  config={getMemberAvatar(
                    item.member.conversation_id ?? undefined,
                    item.name
                  )}
                  className="h-7 w-7"
                />
              </span>
              <span className="collaboration-global-search-item-body">
                <span className="collaboration-global-search-item-title">
                  {item.name}
                </span>
              </span>
            </button>
          ) : (
            <button
              key={item.key}
              type="button"
              data-testid={`collaboration-global-search-item-${item.name}`}
              className="collaboration-global-search-item"
              onClick={() => {
                setSearchOpen(false);
                setSearchQuery('');
                selectSpace(item.spaceId, true);
              }}
            >
              <span className="collaboration-global-search-avatar">
                <GroupAvatar
                  avatars={item.members.map((member) =>
                    getMemberAvatar(
                      member.conversation_id ?? undefined,
                      displayName(member)
                    )
                  )}
                  size={28}
                />
              </span>
              <span className="collaboration-global-search-item-body">
                <span className="collaboration-global-search-item-title">
                  {item.name}
                </span>
                {item.memberNames ? (
                  <span className="collaboration-global-search-item-subtitle">
                    {item.memberNames}
                  </span>
                ) : null}
              </span>
            </button>
          )
        )}
      </CollaborationGlobalSearchModal>
    );
  }
);

const LAYOUT_PICK_KEYS = [
  'error',
  'handlePreviewDockviewReady',
  'handlePreviewResizePointerDown',
  'hasMountedPreviewTabs',
  'hasThread',
  'isDefaultVirtualSpaceSelected',
  'isResizingPane',
  'listAvatarPx',
  'markActivePreviewMemberViewed',
  'markSpaceInReviewMembersViewed',
  'memberMentionContextValue',
  'openFilePreview',
  'openWorkspacePanel',
  'orderedZones',
  'previewOrder',
  'previewPaneRef',
  'previewPaneWidth',
  'previewResizerSide',
  'runInCollaborationEditorGroup',
  'selected',
  'shellGridTemplateColumns',
  'showPreview',
  'showSpaces',
  'spacesPaneWidth',
  't',
  'threadOrder',
  'virtualDefaultSpaceName',
  'workspace',
] as const;

export function CollaborationSpaceLayout({
  hideSpacesPane = false,
}: {
  hideSpacesPane?: boolean;
} = {}) {
  const canvasHeaderSlot = useCanvasPanelHeaderSlot();
  const {
    error,
    handlePreviewDockviewReady,
    handlePreviewResizePointerDown,
    hasMountedPreviewTabs,
    hasThread,
    isDefaultVirtualSpaceSelected,
    isResizingPane,
    listAvatarPx,
    markActivePreviewMemberViewed,
    markSpaceInReviewMembersViewed,
    memberMentionContextValue,
    openFilePreview,
    openWorkspacePanel,
    orderedZones,
    previewOrder,
    previewPaneRef,
    previewPaneWidth,
    previewResizerSide,
    runInCollaborationEditorGroup,
    selected,
    shellGridTemplateColumns,
    showPreview,
    showSpaces,
    spacesPaneWidth,
    t,
    threadOrder,
    virtualDefaultSpaceName,
    workspace,
  } = useCollaborationSpacePick(LAYOUT_PICK_KEYS);

  const effectiveShowSpaces = hideSpacesPane ? false : showSpaces;
  const effectiveShowPreview = hideSpacesPane ? false : showPreview;
  const effectiveHasMountedPreviewTabs = hideSpacesPane
    ? false
    : hasMountedPreviewTabs;
  const effectiveGridTemplateColumns = hideSpacesPane
    ? 'minmax(0, 1fr)'
    : shellGridTemplateColumns;

  if (!workspace) {
    return (
      <div
        className="collaboration-shell session-hub-shell"
        data-spaces="false"
        data-thread="false"
        data-preview="false"
      >
        <section
          className="collaboration-pane"
          aria-label={t('collaborationSpace.title', '协作空间')}
        >
          <div className="collaboration-pane-body collaboration-empty-stage">
            <div className="collaboration-empty-card settings-surface">
              <p className="collaboration-empty-title">
                {t(
                  'collaborationSpace.openWorkspaceFirst',
                  COPY.openWorkspaceFirst
                )}
              </p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const shellContent = (
    <div
      className={cn(
        'collaboration-shell session-hub-shell',
        isResizingPane && 'is-resizing'
      )}
      data-spaces={effectiveShowSpaces ? 'true' : 'false'}
      data-thread={hasThread ? 'true' : 'false'}
      data-preview={effectiveShowPreview ? 'true' : 'false'}
      data-layout-order={orderedZones.join('-')}
      style={
        {
          gridTemplateColumns: effectiveGridTemplateColumns,
          ...(spacesPaneWidth !== null
            ? { '--collaboration-spaces-width': `${spacesPaneWidth}px` }
            : {}),
          ...(previewPaneWidth !== null
            ? { '--collaboration-preview-width': `${previewPaneWidth}px` }
            : {}),
        } as CSSProperties
      }
    >
      {effectiveShowSpaces ? <GroupListPanel /> : null}

      {hasThread ? (
        <section
          style={
            {
              order: threadOrder,
              '--collaboration-list-avatar': `${listAvatarPx / 16}rem`,
            } as CSSProperties
          }
          className="collaboration-thread"
          data-header-member-bar={canvasHeaderSlot ? 'external' : undefined}
          aria-label={
            selected?.name ??
            (isDefaultVirtualSpaceSelected
              ? virtualDefaultSpaceName
              : t('collaborationSpace.title', '协作空间'))
          }
          onPointerDownCapture={() => {
            if (selected) {
              markSpaceInReviewMembersViewed(selected.space_id);
            }
          }}
          onWheelCapture={() => {
            if (selected) {
              markSpaceInReviewMembersViewed(selected.space_id);
            }
          }}
          onKeyDownCapture={() => {
            if (selected) {
              markSpaceInReviewMembersViewed(selected.space_id);
            }
          }}
        >
          {canvasHeaderSlot
            ? createPortal(
                <div
                  style={
                    {
                      '--collaboration-list-avatar': `${listAvatarPx / 16}rem`,
                    } as CSSProperties
                  }
                  className="collaboration-canvas-header-member-host flex min-w-0 max-w-full items-center"
                >
                  <MemberPanel variant="header" />
                </div>,
                canvasHeaderSlot
              )
            : null}
          <div className="collaboration-thread-body">
            {canvasHeaderSlot ? null : <MemberPanel />}
            <MessageStream />
          </div>

          <CollaborationBackToBottomButton />

          {error ? <p className="collaboration-error">{error}</p> : null}
          <ComposerDock />
          <CollaborationMessageAreaOverlay />
        </section>
      ) : null}

      {effectiveHasMountedPreviewTabs ? (
        <aside
          ref={previewPaneRef}
          style={{ order: previewOrder }}
          hidden={!effectiveShowPreview}
          className={cn(
            'collaboration-pane collaboration-preview',
            !effectiveShowPreview && 'hidden'
          )}
          aria-label={t('collaborationSpace.previewTitle', '预览')}
          onPointerDownCapture={markActivePreviewMemberViewed}
          onWheelCapture={markActivePreviewMemberViewed}
          onKeyDownCapture={markActivePreviewMemberViewed}
        >
          {effectiveShowPreview && hasThread ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={i18n.t('panels:ui.collabPage.resizePreview')}
              data-testid="collaboration-preview-resizer"
              data-side={previewResizerSide}
              className="workspace-resize-handle collaboration-preview-resizer"
              onPointerDown={handlePreviewResizePointerDown}
            />
          ) : null}
          <div className="collaboration-preview-body">
            <DockviewReact
              components={COLLABORATION_PREVIEW_COMPONENTS}
              defaultTabComponent={CollaborationPreviewDockviewTab}
              leftHeaderActionsComponent={WorkspaceTabAddMenu}
              rightHeaderActionsComponent={CollaborationPreviewHeaderActions}
              onReady={handlePreviewDockviewReady}
              className="dockview-theme-light dockview-theme-ayu h-full w-full"
              disableFloatingGroups={true}
            />
          </div>
        </aside>
      ) : null}
      <CollaborationDragGhost />
      <CollaborationGlobalSearchOverlay />
    </div>
  );

  return (
    <CollaborationMemberMentionContext.Provider
      value={memberMentionContextValue}
    >
      {hideSpacesPane ? (
        shellContent
      ) : (
        <CollaborationPreviewScope
          onOpenFile={openFilePreview}
          onOpenWorkspacePanel={openWorkspacePanel}
          onRunInEditorGroup={runInCollaborationEditorGroup}
        >
          {shellContent}
        </CollaborationPreviewScope>
      )}
    </CollaborationMemberMentionContext.Provider>
  );
}
