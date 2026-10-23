import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type IDockviewPanelProps } from 'dockview-react';
import { Check, ChevronDown, Pencil, Plus, Upload, X } from 'lucide-react';

import { AttachmentFileCard } from '@/components/NormalizedConversation/attachments/AttachmentFileCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { hostFileSrc, releaseHostFileSrc } from '@/lib/hostAsset';
import { cn } from '@/lib/utils';
import { joinLocalPath } from '@/utils/displayPath';
import {
  clearCurrentDraggedFileReference,
  getCurrentDraggedFileReference,
} from '@/utils/fileReferenceDrag';
import {
  FILE_REFERENCE_DRAG_MIME,
  parseFileReferencePayload,
} from '@/utils/fileReferences';
import { attachmentPreviewKind } from '@/utils/mediaAttachments';

import { GroupAvatar } from './GroupAvatar';
import {
  collaborationCall,
  listenCollaborationSpaceChanged,
} from './collaborationApi';
import {
  MemberBotAvatar,
  deriveMemberBotAvatar,
  readMemberBotAvatars,
  type MemberBotAvatarConfig,
} from './MemberBotAvatar';
import {
  COPY,
  SPACE_TAG_PRESETS,
  parseSpaceChangedEvent,
  readSpaceTags,
  surfaceErrorCopy,
} from './spaceModel';

/** Group avatar used everywhere a collaboration space/thread is shown. */
export function CollaborationSpaceIcon({
  avatars,
  tagPreset,
  className,
}: {
  avatars: readonly MemberBotAvatarConfig[];
  tagPreset?: (typeof SPACE_TAG_PRESETS)[number];
  className?: string;
}) {
  return (
    <GroupAvatar
      avatars={avatars}
      tagColor={tagPreset ? `hsl(${tagPreset.hue})` : undefined}
      tagId={tagPreset?.id}
      className={cn('collaboration-space-icon', className)}
      data-testid="collaboration-space-icon"
    />
  );
}

export const SPACE_COLLECTION_MAX_BYTES = 200 * 1024 * 1024;

export type SpaceCollectionReadRecord = {
  reader_key?: string;
  reader_kind?: string;
  reader_conversation_id?: string | null;
  reader_nickname: string;
  read_count?: number;
  first_read_at?: string;
  last_read_at?: string;
  read_at?: string;
};

export type SpaceCollectionItemRecord = {
  id: string;
  space_id: string;
  project_id: string;
  creator_conversation_id?: string | null;
  creator_nickname: string;
  item_kind?: 'text' | 'image' | 'file' | string;
  kind?: 'text' | 'image' | 'file' | string;
  file_name?: string;
  name?: string;
  file_path: string;
  mime_type?: string | null;
  byte_size: number;
  note: string;
  created_at: string;
  text_content?: string | null;
  read_receipts?: SpaceCollectionReadRecord[];
  reads?: SpaceCollectionReadRecord[];
};

export type SpaceCollectionPanelParams = {
  spaceId: string;
  spaceName?: string;
  spaceAvatars?: MemberBotAvatarConfig[];
  tagColorId?: string;
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
};

export function spaceCollectionPreviewPanelId(spaceId: string): string {
  return `collaboration-collection:${spaceId}`;
}

export function formatCollectionTime(iso: string): string {
  if (!iso) return '-';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export function SpaceCollectionImagePreview({
  filePath,
  name,
}: {
  filePath: string;
  name: string;
}) {
  const panelActions = useOptionalPanelActionsContext();
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void hostFileSrc(filePath)
      .then((resolved) => {
        if (active) setSrc(resolved || filePath);
      })
      .catch(() => {
        if (active) setSrc(filePath);
      });
    return () => {
      active = false;
      releaseHostFileSrc(filePath);
    };
  }, [filePath]);

  return (
    <div className="collaboration-collection-image-wrap">
      <button
        type="button"
        className="collaboration-collection-image-btn"
        aria-label={`预览图片 ${name}`}
        onClick={() => {
          panelActions?.openImagePreview(src || filePath, { title: name });
        }}
      >
        {src ? <img src={src} alt={name} loading="lazy" /> : null}
      </button>
      <span className="truncate text-xs text-muted-foreground">{name}</span>
    </div>
  );
}

export function CollaborationSpaceCollectionDockviewPanel(
  props: IDockviewPanelProps<SpaceCollectionPanelParams>
) {
  const {
    spaceId,
    spaceName,
    spaceAvatars: paramSpaceAvatars,
    tagColorId: paramTagColorId,
    projectId,
    workspacePath,
  } = props.params;
  const panelActions = useOptionalPanelActionsContext();
  const [items, setItems] = useState<SpaceCollectionItemRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [textName, setTextName] = useState('');
  const [textContent, setTextContent] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [collapsedItemIds, setCollapsedItemIds] = useState<Set<string>>(
    () => new Set()
  );
  const [expandedReadItemIds, setExpandedReadItemIds] = useState<Set<string>>(
    () => new Set()
  );
  const [editingNoteItemId, setEditingNoteItemId] = useState<string | null>(
    null
  );
  const [editingNoteDraft, setEditingNoteDraft] = useState('');
  const [savingNoteItemId, setSavingNoteItemId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const memberAvatars = useMemo(() => readMemberBotAvatars(), []);
  const spaceTagPreset = useMemo(() => {
    const colorId = paramTagColorId ?? readSpaceTags()[spaceId]?.colorId;
    return colorId
      ? SPACE_TAG_PRESETS.find((preset) => preset.id === colorId)
      : undefined;
  }, [paramTagColorId, spaceId]);
  const resolvedSpaceAvatars = useMemo(() => {
    if (paramSpaceAvatars && paramSpaceAvatars.length > 0) {
      return paramSpaceAvatars;
    }
    return [deriveMemberBotAvatar(spaceId || spaceName || 'space')];
  }, [paramSpaceAvatars, spaceId, spaceName]);

  const getAvatar = useCallback(
    (
      conversationId?: string | null,
      nickname?: string
    ): MemberBotAvatarConfig => {
      const convKey = conversationId?.trim() ?? '';
      const nickKey = nickname?.trim() ?? '';
      if (convKey && memberAvatars[convKey]) return memberAvatars[convKey];
      if (nickKey && memberAvatars[nickKey]) return memberAvatars[nickKey];
      return deriveMemberBotAvatar(convKey || nickKey || 'bot');
    },
    [memberAvatars]
  );

  const loadCollection = useCallback(async () => {
    if (!spaceId) return;
    try {
      const response = await collaborationCall<{
        items?: SpaceCollectionItemRecord[];
      }>('collaboration', 'space.listCollection', { spaceId });
      setItems(response.items ?? []);
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    setLoading(true);
    void loadCollection();
  }, [loadCollection]);

  useEffect(() => {
    if (!spaceId) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenCollaborationSpaceChanged((payload) => {
      const event = parseSpaceChangedEvent(payload);
      if (!active || !event || event.spaceId !== spaceId) return;
      void loadCollection();
    }).then((stop) => {
      if (!active) stop();
      else unlisten = stop;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [loadCollection, spaceId]);

  const toggleItemCollapsed = useCallback((itemId: string) => {
    setCollapsedItemIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  const toggleReadLog = useCallback((itemId: string) => {
    setExpandedReadItemIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  const handleSaveNote = useCallback(
    async (itemId: string, rawNote: string) => {
      if (!spaceId || !itemId || savingNoteItemId === itemId) return;
      const trimmedNote = rawNote.trim();
      setSavingNoteItemId(itemId);
      setError('');
      try {
        await collaborationCall('collaboration', 'space.updateCollectionItem', {
          spaceId,
          itemId,
          note: trimmedNote,
        });
        setItems((current) =>
          current.map((entry) =>
            entry.id === itemId ? { ...entry, note: trimmedNote } : entry
          )
        );
        setEditingNoteItemId(null);
        await loadCollection();
      } catch (cause) {
        setError(surfaceErrorCopy(cause));
      } finally {
        setSavingNoteItemId(null);
      }
    },
    [loadCollection, savingNoteItemId, spaceId]
  );

  const handleAddTextSubmit = async () => {
    const trimmed = textContent.trim();
    if (!trimmed || !spaceId || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await collaborationCall('collaboration', 'space.addCollectionItem', {
        spaceId,
        projectId: projectId || undefined,
        kind: 'text',
        name: textName.trim() || undefined,
        content: trimmed,
        note: noteInput.trim() || undefined,
        creatorNickname: 'User',
      });
      setTextName('');
      setTextContent('');
      setNoteInput('');
      setAddFormOpen(false);
      await loadCollection();
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddFiles = useCallback(
    async (files: File[]) => {
      if (!spaceId || files.length === 0) return;
      setError('');
      for (const file of files) {
        if (file.size > SPACE_COLLECTION_MAX_BYTES) {
          setError('文件大小不能超过 200MB');
          return;
        }
      }
      setSubmitting(true);
      try {
        for (const file of files) {
          const nativePath = (file as File & { path?: string }).path?.trim();
          const kind =
            file.type.startsWith('image/') ||
            attachmentPreviewKind(file.name, file.type) === 'image'
              ? 'image'
              : 'file';
          if (nativePath) {
            await collaborationCall(
              'collaboration',
              'space.addCollectionItem',
              {
                spaceId,
                projectId: projectId || undefined,
                kind,
                name: file.name,
                sourcePath: nativePath,
                mimeType: file.type || undefined,
                note: noteInput.trim() || undefined,
                creatorNickname: 'User',
              }
            );
          } else {
            const base64Data = await fileToBase64(file);
            await collaborationCall(
              'collaboration',
              'space.addCollectionItem',
              {
                spaceId,
                projectId: projectId || undefined,
                kind,
                name: file.name,
                base64Data,
                mimeType: file.type || undefined,
                note: noteInput.trim() || undefined,
                creatorNickname: 'User',
              }
            );
          }
        }
        await loadCollection();
      } catch (cause) {
        setError(surfaceErrorCopy(cause));
      } finally {
        setSubmitting(false);
      }
    },
    [loadCollection, noteInput, projectId, spaceId]
  );

  const handleAddSourcePath = useCallback(
    async (fullPath: string, displayName?: string) => {
      if (!spaceId || !fullPath) return;
      setSubmitting(true);
      setError('');
      try {
        const name =
          displayName ||
          fullPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
          'file';
        const kind = attachmentPreviewKind(name) === 'image' ? 'image' : 'file';
        await collaborationCall('collaboration', 'space.addCollectionItem', {
          spaceId,
          projectId: projectId || undefined,
          kind,
          name,
          sourcePath: fullPath,
          note: noteInput.trim() || undefined,
          creatorNickname: 'User',
        });
        await loadCollection();
      } catch (cause) {
        setError(surfaceErrorCopy(cause));
      } finally {
        setSubmitting(false);
      }
    },
    [loadCollection, noteInput, projectId, spaceId]
  );

  return (
    <div
      className={cn(
        'collaboration-collection-panel',
        isDragOver && 'is-drag-over'
      )}
      data-testid="collaboration-space-collection-panel"
      onDragOver={(event) => {
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'copy';
        }
        if (!isDragOver) setIsDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsDragOver(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragOver(false);
        const droppedFiles = Array.from(event.dataTransfer?.files ?? []);
        if (droppedFiles.length > 0) {
          void handleAddFiles(droppedFiles);
          return;
        }
        const rawRef =
          event.dataTransfer?.getData(FILE_REFERENCE_DRAG_MIME) ?? '';
        const fileRef =
          parseFileReferencePayload(rawRef) ?? getCurrentDraggedFileReference();
        clearCurrentDraggedFileReference();
        if (fileRef && fileRef.kind === 'file' && workspacePath) {
          void handleAddSourcePath(
            joinLocalPath(workspacePath, fileRef.relativePath),
            fileRef.fileName
          );
        }
      }}
    >
      <div className="collaboration-collection-header">
        <div className="collaboration-collection-title-group">
          {spaceName ? (
            <span
              className="collaboration-collection-space-chip"
              data-testid="collaboration-collection-space-chip"
            >
              <CollaborationSpaceIcon
                avatars={resolvedSpaceAvatars}
                tagPreset={spaceTagPreset}
                className="collaboration-space-icon--sm"
              />
              <span className="truncate">{spaceName}</span>
            </span>
          ) : null}
          <span className="workspace-session-group-count">{items.length}</span>
        </div>
        <div className="collaboration-collection-actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            data-testid="collaboration-collection-file-input"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              if (files.length > 0) {
                void handleAddFiles(files);
              }
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={submitting}
            className="collaboration-collection-action-btn"
            data-testid="collaboration-collection-add-text-toggle"
            onClick={() => setAddFormOpen((current) => !current)}
          >
            <Plus className="mr-1 h-3 w-3" aria-hidden="true" />
            添加文本
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={submitting}
            className="collaboration-collection-action-btn"
            data-testid="collaboration-collection-upload-file-btn"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="mr-1 h-3 w-3" aria-hidden="true" />
            上传文件
          </Button>
        </div>
      </div>

      {addFormOpen ? (
        <div
          className="collaboration-collection-add-form"
          data-testid="collaboration-collection-add-form"
        >
          <Input
            aria-label="收藏名称"
            value={textName}
            onChange={(event) => setTextName(event.target.value)}
            placeholder="名称（可选，如 api-spec.md）"
            className="h-7 px-2 text-xs"
          />
          <Textarea
            aria-label="收藏文本内容"
            value={textContent}
            onChange={(event) => setTextContent(event.target.value)}
            placeholder="输入要收藏的文本内容..."
            rows={3}
            className="text-xs"
          />
          <Input
            aria-label="收藏备注"
            value={noteInput}
            onChange={(event) => setNoteInput(event.target.value)}
            placeholder="备注（可选）"
            className="h-7 px-2 text-xs"
          />
          <div className="flex justify-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setAddFormOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="primary"
              size="xs"
              disabled={!textContent.trim() || submitting}
              data-testid="collaboration-collection-submit-text-btn"
              onClick={() => {
                void handleAddTextSubmit();
              }}
            >
              添加到群收藏
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p
          className="collaboration-error px-3 pt-2 text-xs"
          data-testid="collaboration-collection-error"
        >
          {error}
        </p>
      ) : null}

      <div
        className="collaboration-collection-list"
        data-testid="collaboration-collection-list"
      >
        {loading ? (
          <p className="collaboration-preview-empty">加载中</p>
        ) : items.length === 0 ? (
          <p className="collaboration-preview-empty">
            暂无群收藏记录，成员或你添加的文本、图片和文件会显示在这里
          </p>
        ) : (
          items.map((item) => {
            const isCollapsed = collapsedItemIds.has(item.id);
            const isReadsExpanded = expandedReadItemIds.has(item.id);
            const isEditingNote = editingNoteItemId === item.id;
            const itemKind = item.item_kind ?? item.kind ?? 'file';
            const itemName = item.file_name ?? item.name ?? '';
            const itemReads = item.read_receipts ?? item.reads ?? [];
            const kindLabel =
              itemKind === 'image'
                ? '图片'
                : itemKind === 'file'
                  ? '文件'
                  : '文本';
            const creatorIsUser =
              !item.creator_conversation_id &&
              (item.creator_nickname === 'user' ||
                item.creator_nickname === 'User' ||
                item.creator_nickname === COPY.you);
            const creatorDisplay =
              creatorIsUser ||
              item.creator_nickname === 'user' ||
              item.creator_nickname === COPY.you
                ? 'User'
                : item.creator_nickname;
            return (
              <article
                key={item.id}
                className={cn(
                  'collaboration-collection-card',
                  isCollapsed && 'is-collapsed'
                )}
                data-testid={`collection-item-${item.id}`}
                data-collapsed={isCollapsed ? 'true' : 'false'}
              >
                <div
                  className="collaboration-collection-card-header"
                  onClick={() => toggleItemCollapsed(item.id)}
                >
                  <div
                    className="collaboration-collection-creator"
                    data-testid={`collection-item-creator-${item.id}`}
                  >
                    <MemberBotAvatar
                      config={getAvatar(
                        item.creator_conversation_id,
                        creatorDisplay
                      )}
                      className="h-4 w-4 shrink-0"
                    />
                    <span className="truncate">{creatorDisplay}</span>
                  </div>
                  <div className="collaboration-collection-card-header-right">
                    <span
                      className="collaboration-collection-kind-badge"
                      data-testid={`collection-item-kind-${item.id}`}
                    >
                      {kindLabel}
                    </span>
                    <button
                      type="button"
                      className="collaboration-collection-collapse-btn"
                      data-testid={`collection-item-collapse-toggle-${item.id}`}
                      aria-expanded={!isCollapsed}
                      aria-label={isCollapsed ? '展开收藏记录' : '折叠收藏记录'}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleItemCollapsed(item.id);
                      }}
                    >
                      <ChevronDown
                        className={cn(
                          'h-3.5 w-3.5 transition-transform',
                          isCollapsed && '-rotate-90'
                        )}
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                </div>

                {!isCollapsed ? (
                  <>
                    <div
                      className="collaboration-collection-card-content"
                      data-testid={`collection-item-content-${item.id}`}
                    >
                      {itemKind === 'text' ? (
                        <div className="collaboration-collection-text-content">
                          {item.text_content ?? itemName}
                        </div>
                      ) : itemKind === 'image' ? (
                        <SpaceCollectionImagePreview
                          filePath={item.file_path}
                          name={itemName}
                        />
                      ) : (
                        <AttachmentFileCard
                          name={itemName}
                          sizeBytes={item.byte_size}
                          modifiedAt={item.created_at}
                          onClick={() =>
                            panelActions?.openFilePreview(item.file_path)
                          }
                        />
                      )}
                    </div>

                    <div
                      className="collaboration-collection-note"
                      data-testid={`collection-item-note-${item.id}`}
                    >
                      <span className="collaboration-collection-meta-label">
                        备注：
                      </span>
                      {isEditingNote ? (
                        <div className="collaboration-collection-note-editor">
                          <Input
                            aria-label="编辑收藏备注"
                            data-testid={`collection-item-note-input-${item.id}`}
                            value={editingNoteDraft}
                            disabled={savingNoteItemId === item.id}
                            autoFocus
                            placeholder="输入备注..."
                            className="h-6 flex-1 px-2 text-xs"
                            onChange={(event) =>
                              setEditingNoteDraft(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                void handleSaveNote(item.id, editingNoteDraft);
                              } else if (event.key === 'Escape') {
                                event.preventDefault();
                                setEditingNoteItemId(null);
                              }
                            }}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0"
                            aria-label="保存备注"
                            data-testid={`collection-item-note-save-${item.id}`}
                            disabled={savingNoteItemId === item.id}
                            onClick={() => {
                              void handleSaveNote(item.id, editingNoteDraft);
                            }}
                          >
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0"
                            aria-label="取消编辑备注"
                            data-testid={`collection-item-note-cancel-${item.id}`}
                            disabled={savingNoteItemId === item.id}
                            onClick={() => setEditingNoteItemId(null)}
                          >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="collaboration-collection-note-display"
                          data-testid={`collection-item-note-edit-${item.id}`}
                          aria-label="编辑备注"
                          title="点击编辑备注"
                          onClick={() => {
                            setEditingNoteItemId(item.id);
                            setEditingNoteDraft(item.note || '');
                          }}
                        >
                          <span>{item.note || '无'}</span>
                          <Pencil
                            className="collaboration-collection-note-edit-icon h-3 w-3 shrink-0"
                            aria-hidden="true"
                          />
                        </button>
                      )}
                    </div>

                    <div className="collaboration-collection-card-footer">
                      <span data-testid={`collection-item-time-${item.id}`}>
                        创建时间：{formatCollectionTime(item.created_at)}
                      </span>
                      <button
                        type="button"
                        className="collaboration-collection-reads-toggle"
                        data-testid={`collection-item-reads-toggle-${item.id}`}
                        aria-expanded={isReadsExpanded}
                        onClick={() => toggleReadLog(item.id)}
                      >
                        <span>读取记录 ({itemReads.length})</span>
                        <ChevronDown
                          className={cn(
                            'h-3 w-3 transition-transform',
                            isReadsExpanded && 'rotate-180'
                          )}
                          aria-hidden="true"
                        />
                      </button>
                    </div>

                    {isReadsExpanded ? (
                      <div
                        className="collaboration-collection-reads-panel"
                        data-testid={`collection-item-reads-list-${item.id}`}
                      >
                        {itemReads.length === 0 ? (
                          <p className="collaboration-collection-reads-empty">
                            暂无成员读取记录
                          </p>
                        ) : (
                          <ul className="collaboration-collection-reads-list">
                            {itemReads.map((read, readIndex) => (
                              <li
                                key={
                                  read.reader_key ??
                                  read.reader_conversation_id ??
                                  `${item.id}-${readIndex}`
                                }
                                className="collaboration-collection-read-row"
                              >
                                <span className="collaboration-collection-read-member">
                                  <MemberBotAvatar
                                    config={getAvatar(
                                      read.reader_conversation_id,
                                      read.reader_nickname
                                    )}
                                    className="h-3.5 w-3.5 shrink-0"
                                  />
                                  <span className="truncate">
                                    {read.reader_nickname}
                                  </span>
                                </span>
                                <span className="collaboration-collection-read-meta">
                                  读取 {read.read_count ?? 1} 次 ·{' '}
                                  {formatCollectionTime(
                                    read.last_read_at ?? read.read_at ?? ''
                                  )}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </article>
            );
          })
        )}
      </div>

      <div
        role="button"
        tabIndex={0}
        className="collaboration-collection-dropzone"
        data-testid="collaboration-collection-dropzone"
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            fileInputRef.current?.click();
          }
        }}
      >
        <Upload className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>拖拽文件到此处或点击上传（单文件最大 200MB）</span>
      </div>
    </div>
  );
}
