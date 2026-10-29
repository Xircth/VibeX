import { type CSSProperties } from 'react';
import { DockviewReact } from 'dockview-react';
import { ChevronDown } from 'lucide-react';

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
  useCollaborationSpace,
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

function CollaborationSpaceLayout() {
  const {
    draggingMember,
    draggingThreadName,
    error,
    getMemberAvatar,
    globalSearchResults,
    handlePreviewDockviewReady,
    handlePreviewResizePointerDown,
    hasMountedPreviewTabs,
    hasThread,
    isAtThreadBottom,
    isDefaultVirtualSpaceSelected,
    isResizingPane,
    listAvatarPx,
    markActivePreviewMemberViewed,
    markSpaceInReviewMembersViewed,
    memberMentionContextValue,
    openFilePreview,
    openPrivateChat,
    openWorkspacePanel,
    orderedZones,
    pinThreadLogToBottom,
    pointerDragCursor,
    previewOrder,
    previewPaneRef,
    previewPaneWidth,
    previewResizerSide,
    renderMessageAreaOverlay,
    runInCollaborationEditorGroup,
    searchOpen,
    searchQuery,
    selectSpace,
    selected,
    setSearchOpen,
    setSearchQuery,
    shellGridTemplateColumns,
    showPreview,
    showSpaces,
    spacesPaneWidth,
    t,
    threadOrder,
    virtualDefaultSpaceName,
    workspace,
  } = useCollaborationSpace();

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

  return (
    <CollaborationMemberMentionContext.Provider
      value={memberMentionContextValue}
    >
      <CollaborationPreviewScope
        onOpenFile={openFilePreview}
        onOpenWorkspacePanel={openWorkspacePanel}
        onRunInEditorGroup={runInCollaborationEditorGroup}
      >
        <div
          className={cn(
            'collaboration-shell session-hub-shell',
            isResizingPane && 'is-resizing'
          )}
          data-spaces={showSpaces ? 'true' : 'false'}
          data-thread={hasThread ? 'true' : 'false'}
          data-preview={showPreview ? 'true' : 'false'}
          data-layout-order={orderedZones.join('-')}
          style={
            {
              gridTemplateColumns: shellGridTemplateColumns,
              ...(spacesPaneWidth !== null
                ? { '--collaboration-spaces-width': `${spacesPaneWidth}px` }
                : {}),
              ...(previewPaneWidth !== null
                ? { '--collaboration-preview-width': `${previewPaneWidth}px` }
                : {}),
            } as CSSProperties
          }
        >
          {showSpaces ? <GroupListPanel /> : null}

          {hasThread ? (
            <section
              style={
                {
                  order: threadOrder,
                  '--collaboration-list-avatar': `${listAvatarPx / 16}rem`,
                } as CSSProperties
              }
              className="collaboration-thread"
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
              <div className="collaboration-thread-body">
                <MemberPanel />
                <MessageStream />
              </div>

              {selected && !isAtThreadBottom ? (
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
              ) : null}

              {error ? <p className="collaboration-error">{error}</p> : null}
              <ComposerDock />
              {renderMessageAreaOverlay()}
            </section>
          ) : null}

          {hasMountedPreviewTabs ? (
            <aside
              ref={previewPaneRef}
              style={{ order: previewOrder }}
              hidden={!showPreview}
              className={cn(
                'collaboration-pane collaboration-preview',
                !showPreview && 'hidden'
              )}
              aria-label={t('collaborationSpace.previewTitle', '预览')}
              onPointerDownCapture={markActivePreviewMemberViewed}
              onWheelCapture={markActivePreviewMemberViewed}
              onKeyDownCapture={markActivePreviewMemberViewed}
            >
              {showPreview && hasThread ? (
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
                  rightHeaderActionsComponent={
                    CollaborationPreviewHeaderActions
                  }
                  onReady={handlePreviewDockviewReady}
                  className="dockview-theme-light dockview-theme-ayu h-full w-full"
                  disableFloatingGroups={true}
                />
              </div>
            </aside>
          ) : null}
          {draggingMember && pointerDragCursor ? (
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
          {draggingThreadName && pointerDragCursor ? (
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
          {searchOpen ? (
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
          ) : null}
        </div>
      </CollaborationPreviewScope>
    </CollaborationMemberMentionContext.Provider>
  );
}
