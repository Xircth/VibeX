import {
  Bot,
  Check,
  Clock,
  Filter,
  FolderPlus,
  MessageSquare,
  Plus,
  Search,
  Tag,
  Trash2,
  Type,
} from 'lucide-react';
import {
  SESSION_LIST_ACTION_BUTTON_CLASS,
  SESSION_LIST_ACTION_ICON_CLASS,
} from '@/components/kanban/session-hub/utils';
import { ProductContextMenu } from '@/components/context-menu/ProductContextMenu';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  PRODUCT_MENU_CONTENT_CLASS,
  PRODUCT_MENU_ITEM_CLASS,
} from '@/components/ui/product-menu-classes';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { SessionListDeleteControl } from '@/components/workspace-session-list/SessionListDeleteControl';
import { cn } from '@/lib/utils';
import i18n from '@/i18n';
import { COPY } from '../spaceModel';
import { cycleTypeFilter } from '../contactChrome';
import { ContactGroupSections } from '../ContactGroupSections';

import { useCollaborationSpace } from './SpaceContext';

export function GroupListPanel() {
  const {
    collapsedSections,
    confirmBatchDelete,
    contactGroups,
    contactMenu,
    contactSections,
    createGroup,
    handleSpacesResizePointerDown,
    handleToggleDeleteMode,
    hasActiveFilter,
    hasThread,
    hiddenChatList,
    isDeleteMode,
    isDeletingBatch,
    listSort,
    messageMenu,
    moveContactToSection,
    newGroupMenuItem,
    openContactMenu,
    openCreateMemberDialog,
    openCreateSpaceDialog,
    openSectionContactMenu,
    renameGroup,
    renamingGroupId,
    renderSectionEntry,
    selectedDeleteCount,
    setContactMenu,
    setListSort,
    setMessageMenu,
    setRenamingGroupId,
    setSearchOpen,
    setSearchQuery,
    setTypeFilter,
    showPreview,
    sidebarAvailable,
    sidebarDropTarget,
    spacesOrder,
    spacesPaneRef,
    spacesResizerSide,
    t,
    toggleContactSection,
    typeFilter,
    visibleChatList,
  } = useCollaborationSpace();

  return (
    <>
          <aside
            ref={spacesPaneRef}
            style={{ order: spacesOrder }}
            className="collaboration-pane"
            aria-label={t('collaborationSpace.title', '协作空间')}
          >
            <div className="collaboration-pane-body session-hub-list-body collaboration-pane-list-container">
              <div className="collaboration-top-toolbar flex w-full min-w-0 flex-nowrap items-center justify-between gap-2 overflow-hidden px-1 py-0.5">
                {isDeleteMode ? (
                  <SessionListDeleteControl
                    selectedCount={selectedDeleteCount}
                    isDeleting={isDeletingBatch}
                    selectLabel={i18n.t('panels:ui.collabPage.selectSpacesOrBots')}
                    selectedCountLabel={i18n.t('panels:ui.collabPage.selecteddeletecountSelected', { selectedDeleteCount: selectedDeleteCount })}
                    deleteLabel={i18n.t('panels:ui.collabPage.confirmDelete')}
                    deletingLabel={i18n.t('panels:ui.collabPage.deleting')}
                    cancelLabel={i18n.t('panels:ui.collabPage.cancel')}
                    onDelete={() => {
                      void confirmBatchDelete();
                    }}
                    onCancel={handleToggleDeleteMode}
                  />
                ) : (
                  <>
                    <div className="ml-auto flex min-w-0 flex-nowrap items-center justify-end gap-1">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        data-testid="collaboration-global-search-button"
                        className={SESSION_LIST_ACTION_BUTTON_CLASS}
                        aria-label={i18n.t('panels:ui.collabPage.searchSpacesOrBots')}
                        onClick={() => {
                          setSearchQuery('');
                          setSearchOpen(true);
                        }}
                      >
                        <Search className={SESSION_LIST_ACTION_ICON_CLASS} />
                      </Button>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className={SESSION_LIST_ACTION_BUTTON_CLASS}
                            aria-label={COPY.createMenu}
                          >
                            <Plus className={SESSION_LIST_ACTION_ICON_CLASS} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          onCloseAutoFocus={(event) => event.preventDefault()}
                        >
                          <DropdownMenuItem onSelect={openCreateSpaceDialog}>
                            <MessageSquare
                              className="size-3.5 shrink-0"
                              aria-hidden="true"
                            />
                            <span>{COPY.newSpaceButton}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => openCreateMemberDialog()}
                          >
                            <Bot
                              className="size-3.5 shrink-0"
                              aria-hidden="true"
                            />
                            <span>{COPY.createAssistantButton}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              void createGroup();
                            }}
                          >
                            <FolderPlus
                              className="size-3.5 shrink-0"
                              aria-hidden="true"
                            />
                            <span>{COPY.createContactGroupButton}</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className={cn(
                              SESSION_LIST_ACTION_BUTTON_CLASS,
                              hasActiveFilter && 'bg-secondary text-foreground'
                            )}
                            aria-label={COPY.filterLabel}
                          >
                            <Filter
                              className={SESSION_LIST_ACTION_ICON_CLASS}
                            />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          align="end"
                          className={cn(PRODUCT_MENU_CONTENT_CLASS, 'w-44')}
                        >
                          {(
                            [
                              {
                                id: 'name' as const,
                                label: COPY.filterByName,
                                icon: Type,
                                active: listSort === 'name',
                                onSelect: () => {
                                  setListSort('name');
                                  setTypeFilter('group');
                                },
                              },
                              {
                                id: 'type' as const,
                                label: `${COPY.filterByType} · ${
                                  typeFilter === 'group'
                                    ? COPY.filterTypeGroup
                                    : COPY.filterTypeAssistant
                                }`,
                                icon: Tag,
                                active: listSort === 'type',
                                onSelect: () => {
                                  const next = cycleTypeFilter(
                                    listSort,
                                    typeFilter
                                  );
                                  setListSort(next.sort);
                                  setTypeFilter(next.typeFilter);
                                },
                              },
                              {
                                id: 'activity' as const,
                                label: COPY.filterByActiveTime,
                                icon: Clock,
                                active: listSort === 'activity',
                                onSelect: () => {
                                  setListSort('activity');
                                  setTypeFilter('group');
                                },
                              },
                            ] as const
                          ).map((option) => {
                            const OptionIcon = option.icon;
                            return (
                              <button
                                key={option.id}
                                type="button"
                                role="menuitem"
                                data-testid={`collaboration-filter-${option.id}`}
                                className={cn(
                                  PRODUCT_MENU_ITEM_CLASS,
                                  'w-full px-2.5 py-1.5'
                                )}
                                onClick={option.onSelect}
                              >
                                <OptionIcon
                                  className="size-3.5 shrink-0"
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 text-left">
                                  {option.label}
                                </span>
                                {option.active ? (
                                  <Check
                                    className="size-3.5 shrink-0"
                                    aria-hidden="true"
                                  />
                                ) : null}
                              </button>
                            );
                          })}
                        </PopoverContent>
                      </Popover>

                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className={SESSION_LIST_ACTION_BUTTON_CLASS}
                        aria-label={COPY.batchDeleteLabel}
                        onClick={handleToggleDeleteMode}
                      >
                        <Trash2 className={SESSION_LIST_ACTION_ICON_CLASS} />
                      </Button>
                    </div>
                  </>
                )}
              </div>

              <div
                className="collaboration-space-list"
                onDragOver={(event) => {
                  event.preventDefault();
                  if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = 'move';
                  }
                }}
                onContextMenu={(event) => {
                  if (!sidebarAvailable || contactGroups === null) return;
                  openContactMenu(event, [newGroupMenuItem]);
                }}
              >
                {contactSections ? (
                  <ContactGroupSections
                    sections={contactSections}
                    collapsed={collapsedSections}
                    renamingId={renamingGroupId}
                    renamePlaceholder={t(
                      'collaborationSpace.contactGroupNamePlaceholder',
                      '分组名称'
                    )}
                    toggleLabel={(name) =>
                      t('collaborationSpace.contactGroupToggle', {
                        name,
                        defaultValue: '折叠或展开 {{name}}',
                      })
                    }
                    onToggle={toggleContactSection}
                    onRenameSubmit={(groupId, name) => {
                      setRenamingGroupId(null);
                      void renameGroup(groupId, name);
                    }}
                    onRenameCancel={() => setRenamingGroupId(null)}
                    onHeaderContextMenu={openSectionContactMenu}
                    dropTargetId={
                      sidebarDropTarget?.kind === 'section'
                        ? sidebarDropTarget.sectionId
                        : null
                    }
                    onDropContact={(sectionId, threadId) =>
                      void moveContactToSection(threadId, sectionId)
                    }
                    renderEntry={renderSectionEntry}
                  />
                ) : (
                  <>{visibleChatList.map(renderSectionEntry)}</>
                )}
                {hiddenChatList.length > 0 ? (
                  <section
                    className="collaboration-contact-section"
                    data-testid="collaboration-contact-section-hidden"
                  >
                    <div className="collaboration-contact-section-header">
                      <span className="collaboration-contact-section-name">
                        {i18n.t('panels:ui.collabPage.hidden')}
                      </span>
                      <span className="collaboration-contact-section-count">
                        {hiddenChatList.length}
                      </span>
                    </div>
                    <div className="collaboration-contact-section-body">
                      {hiddenChatList.map(renderSectionEntry)}
                    </div>
                  </section>
                ) : null}
                {contactMenu ? (
                  <ProductContextMenu
                    x={contactMenu.x}
                    y={contactMenu.y}
                    items={contactMenu.items}
                    onClose={() => setContactMenu(null)}
                    ariaLabel={i18n.t('panels:ui.collabPage.contactMenu')}
                  />
                ) : null}
                {messageMenu ? (
                  <ProductContextMenu
                    x={messageMenu.x}
                    y={messageMenu.y}
                    items={messageMenu.items}
                    onClose={() => setMessageMenu(null)}
                    ariaLabel={i18n.t('panels:collabCopy.reply')}
                  />
                ) : null}
              </div>
            </div>
            {hasThread || showPreview ? (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={i18n.t('panels:ui.collabPage.resizeSpaceList')}
                data-testid="collaboration-spaces-resizer"
                data-side={spacesResizerSide}
                className="workspace-resize-handle collaboration-pane-resizer"
                onPointerDown={handleSpacesResizePointerDown}
              />
            ) : null}
          </aside>
    </>
  );
}
