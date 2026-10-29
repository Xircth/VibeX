import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { type IDockviewPanelProps } from 'dockview-react';
import {
  Check,
  ChevronDown,
  Copy,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

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

import {
  collaborationCall,
  listenCollaborationSpaceChanged,
} from './collaborationApi';
import {
  MemberBotAvatar,
  deriveMemberBotAvatar,
  resolveMemberBotAvatar,
  type MemberBotAvatarConfig,
} from './MemberBotAvatar';
import { AssistantDetailsCustomizeTab } from './AssistantDetailsCustomizeTab';
import { AssistantDetailsSessionTab } from './AssistantDetailsSessionTab';
import { GroupAvatar } from './GroupAvatar';
import {
  COLLABORATION_MEMBERS_CHANGED_EVENT,
  GroupDetailsMembersTab,
} from './GroupDetailsMembersTab';
import { GroupDetailsUsageTab } from './GroupDetailsUsageTab';
import { copySpaceCollectionItem } from './copySpaceCollectionItem';
import {
  COPY,
  SPACE_TAG_PRESETS,
  agentRoster,
  collectionDirFromHostPayload,
  displayName,
  isHumanPersonLabel,
  parseSpaceChangedEvent,
  readSpaceTags,
  surfaceErrorCopy,
  type SpaceMember,
} from './spaceModel';
import i18n from '@/i18n';

export function CollaborationSpaceIcon({
  avatars,
  tagPreset,
  className,
}: {
  avatars: readonly MemberBotAvatarConfig[];
  tagPreset?: (typeof SPACE_TAG_PRESETS)[number];
  className?: string;
}) {
  const isSingle = avatars.length === 1;
  const gridCols = avatars.length > 4 ? 3 : 2;
  const cellCount = gridCols * gridCols;

  return (
    <span
      className={cn(
        'collaboration-space-icon',
        isSingle
          ? 'collaboration-space-icon--single'
          : 'collaboration-space-icon--grid',
        className
      )}
      data-testid="collaboration-space-icon"
      data-tag-color={tagPreset?.id}
      data-grid-size={isSingle ? 1 : cellCount}
      style={
        tagPreset
          ? ({
              '--space-icon-bg': `hsl(${tagPreset.hue})`,
              backgroundColor: `hsl(${tagPreset.hue})`,
            } as CSSProperties)
          : undefined
      }
      aria-hidden="true"
    >
      {isSingle ? (
        <MemberBotAvatar
          config={avatars[0]}
          animated={false}
          className="collaboration-space-icon-single-avatar"
        />
      ) : (
        <span
          className={cn(
            'collaboration-space-icon-grid',
            gridCols === 3
              ? 'collaboration-space-icon-grid--3x3'
              : 'collaboration-space-icon-grid--2x2'
          )}
        >
          {Array.from({ length: cellCount }, (_, index) => {
            const avatar = avatars[index];
            return (
              <span
                key={index}
                className="collaboration-space-icon-cell"
                data-testid="collaboration-space-icon-cell"
              >
                {avatar ? (
                  <MemberBotAvatar
                    config={avatar}
                    animated={false}
                    className="collaboration-space-icon-cell-avatar"
                  />
                ) : null}
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}

export const SPACE_COLLECTION_MAX_BYTES = 200 * 1024 * 1024;
const COLLECTION_POLL_MS = 2500;

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
  variant?: 'group' | 'assistant';
  memberId?: string;
  conversationId?: string;
  memberAvatar?: MemberBotAvatarConfig;
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
        aria-label={i18n.t('panels:ui.collection.previewImageName', {
          name: name,
        })}
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
    workspaceId,
    variant = 'group',
    memberId,
    conversationId,
    memberAvatar,
  } = props.params;
  const isAssistant = variant === 'assistant';
  const [detailsTab, setDetailsTab] = useState<
    'details' | 'collection' | 'members' | 'customize'
  >(isAssistant ? 'details' : 'members');
  const [heroName, setHeroName] = useState(spaceName ?? '');
  const [heroAvatar, setHeroAvatar] = useState<MemberBotAvatarConfig | null>(
    memberAvatar ?? null
  );
  useEffect(() => {
    if (spaceName) setHeroName(spaceName);
  }, [spaceName]);
  useEffect(() => {
    if (memberAvatar) setHeroAvatar(memberAvatar);
  }, [memberAvatar]);
  const panelActions = useOptionalPanelActionsContext();
  const [items, setItems] = useState<SpaceCollectionItemRecord[]>([]);
  const [collectionDir, setCollectionDir] = useState('');
  const [pathCopied, setPathCopied] = useState(false);
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
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editingNoteDraft, setEditingNoteDraft] = useState('');
  const [savingNoteItemId, setSavingNoteItemId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pathCopiedTimerRef = useRef<number | null>(null);
  const [liveSpaceAvatars, setLiveSpaceAvatars] = useState<
    MemberBotAvatarConfig[] | null
  >(null);
  const spaceTagPreset = useMemo(() => {
    const colorId = paramTagColorId ?? readSpaceTags()[spaceId]?.colorId;
    return colorId
      ? SPACE_TAG_PRESETS.find((preset) => preset.id === colorId)
      : undefined;
  }, [paramTagColorId, spaceId]);

  const getAvatar = useCallback(
    (
      conversationId?: string | null,
      nickname?: string,
      identityMemberId?: string | null
    ): MemberBotAvatarConfig =>
      resolveMemberBotAvatar({
        conversationId,
        nickname,
        identityMemberId,
      }),
    []
  );

  const refreshHeroAvatars = useCallback(async () => {
    if (isAssistant || !spaceId) return;
    try {
      const page = await collaborationCall<{ members?: SpaceMember[] }>(
        'collaboration',
        'space.listMembers',
        { spaceId }
      );
      setLiveSpaceAvatars(
        agentRoster(page.members ?? []).map((member) =>
          getAvatar(member.conversation_id ?? undefined, displayName(member))
        )
      );
    } catch {
      // Keep the last known avatars from params or a previous successful load.
    }
  }, [getAvatar, isAssistant, spaceId]);

  useEffect(() => {
    void refreshHeroAvatars();
  }, [refreshHeroAvatars]);

  useEffect(() => {
    const onMembersChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ spaceId?: string }>).detail;
      if (detail?.spaceId && detail.spaceId !== spaceId) return;
      void refreshHeroAvatars();
    };
    window.addEventListener(
      COLLABORATION_MEMBERS_CHANGED_EVENT,
      onMembersChanged
    );
    return () => {
      window.removeEventListener(
        COLLABORATION_MEMBERS_CHANGED_EVENT,
        onMembersChanged
      );
    };
  }, [refreshHeroAvatars, spaceId]);

  const resolvedSpaceAvatars = useMemo(() => {
    if (liveSpaceAvatars !== null) return liveSpaceAvatars;
    if (paramSpaceAvatars && paramSpaceAvatars.length > 0) {
      return paramSpaceAvatars;
    }
    return [deriveMemberBotAvatar(spaceId || spaceName || 'space')];
  }, [liveSpaceAvatars, paramSpaceAvatars, spaceId, spaceName]);

  const loadCollection = useCallback(async () => {
    if (!spaceId) return;
    try {
      const response = await collaborationCall<{
        items?: SpaceCollectionItemRecord[];
        collectionDir?: string | null;
        collection_dir?: string | null;
      }>('collaboration', 'space.listCollection', { spaceId });
      setItems(response.items ?? []);
      const nextDir = collectionDirFromHostPayload(response);
      if (nextDir) setCollectionDir(nextDir);
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
    if (detailsTab !== 'collection' || !spaceId) return;
    const timer = window.setInterval(() => {
      void loadCollection();
    }, COLLECTION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [detailsTab, loadCollection, spaceId]);

  useEffect(() => {
    return () => {
      if (pathCopiedTimerRef.current != null) {
        window.clearTimeout(pathCopiedTimerRef.current);
      }
    };
  }, []);

  const handleCopyCollectionDir = useCallback(async () => {
    if (!collectionDir) return;
    try {
      await navigator.clipboard.writeText(collectionDir);
      setPathCopied(true);
      if (pathCopiedTimerRef.current != null) {
        window.clearTimeout(pathCopiedTimerRef.current);
      }
      pathCopiedTimerRef.current = window.setTimeout(() => {
        setPathCopied(false);
        pathCopiedTimerRef.current = null;
      }, 1500);
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    }
  }, [collectionDir]);

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

  const handleCopyItem = useCallback(
    async (item: SpaceCollectionItemRecord) => {
      try {
        await copySpaceCollectionItem(item);
      } catch (cause) {
        setError(surfaceErrorCopy(cause));
      }
    },
    []
  );

  const handleDeleteItem = useCallback(
    async (itemId: string) => {
      if (!spaceId || !itemId || submitting) return;
      setSubmitting(true);
      setError('');
      try {
        await collaborationCall('collaboration', 'space.removeCollectionItem', {
          spaceId,
          itemId,
        });
        setItems((current) => current.filter((entry) => entry.id !== itemId));
        setSelectedItemId((current) => (current === itemId ? null : current));
      } catch (cause) {
        setError(surfaceErrorCopy(cause));
      } finally {
        setSubmitting(false);
      }
    },
    [spaceId, submitting]
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
          setError(i18n.t('panels:ui.collection.fileMustBe200mbOr'));
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
      <div className="collaboration-group-details-hero">
        <button
          type="button"
          className="collaboration-group-details-close"
          aria-label={i18n.t('panels:ui.collection.close')}
          onClick={() => props.api.close()}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        {isAssistant ? (
          <MemberBotAvatar
            config={
              heroAvatar ||
              memberAvatar ||
              resolvedSpaceAvatars[0] ||
              deriveMemberBotAvatar(spaceId || heroName || 'bot')
            }
            className="h-16 w-16"
          />
        ) : (
          <GroupAvatar
            avatars={resolvedSpaceAvatars}
            tagHue={spaceTagPreset?.hue}
            size={64}
            data-testid="collaboration-group-details-avatar"
          />
        )}
        {heroName || spaceName ? (
          <h2 className="collaboration-group-details-name">
            {heroName || spaceName}
          </h2>
        ) : null}
        <div
          className="collaboration-group-details-tabs"
          role="tablist"
          aria-label={
            isAssistant ? COPY.assistantDetailsButton : COPY.groupDetailsButton
          }
        >
          {(isAssistant
            ? ([
                ['details', COPY.assistantDetailsTab],
                ['collection', COPY.assistantCollectionTab],
                ['customize', COPY.assistantCustomizeTab],
              ] as const)
            : ([
                ['details', COPY.groupDetailsTab],
                ['collection', COPY.groupCollectionTab],
                ['members', COPY.groupMembersTab],
              ] as const)
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={detailsTab === id}
              data-testid={`collaboration-group-details-tab-${id}`}
              className="collaboration-group-details-tab"
              onClick={() => setDetailsTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {detailsTab === 'members' && !isAssistant ? (
        <GroupDetailsMembersTab
          spaceId={spaceId}
          workspaceId={workspaceId}
          getAvatar={getAvatar}
        />
      ) : null}

      {detailsTab === 'details' ? (
        isAssistant ? (
          <AssistantDetailsSessionTab conversationId={conversationId} />
        ) : (
          <GroupDetailsUsageTab spaceId={spaceId} getAvatar={getAvatar} />
        )
      ) : null}

      {detailsTab === 'customize' && isAssistant && memberId ? (
        <AssistantDetailsCustomizeTab
          memberId={memberId}
          conversationId={conversationId}
          initialName={heroName || spaceName || ''}
          initialAvatar={
            heroAvatar ||
            memberAvatar ||
            resolvedSpaceAvatars[0] ||
            deriveMemberBotAvatar(spaceId || 'bot')
          }
          onSaved={({ name, avatar }) => {
            setHeroName(name);
            setHeroAvatar(avatar);
            props.api.setTitle(COPY.assistantDetailsButton);
          }}
        />
      ) : null}

      {detailsTab === 'collection' ? (
        <div
          className={cn(
            'collaboration-group-details-body',
            isAssistant && 'collaboration-assistant-details-body'
          )}
        >
          {collectionDir ? (
            <div
              className="collaboration-collection-pathbar"
              data-testid="collaboration-collection-pathbar"
              aria-label={i18n.t('panels:ui.collection.folderPath')}
            >
              <div className="collaboration-collection-path-row">
                <code
                  className="collaboration-collection-path-value"
                  title={collectionDir}
                  data-testid="collaboration-collection-path"
                >
                  {collectionDir}
                </code>
                <button
                  type="button"
                  className="collaboration-collection-path-copy"
                  data-testid="collaboration-collection-copy-path"
                  aria-label={
                    pathCopied
                      ? i18n.t('panels:ui.collection.pathCopied')
                      : i18n.t('panels:ui.collection.copyFolderPath')
                  }
                  onClick={() => {
                    void handleCopyCollectionDir();
                  }}
                >
                  {pathCopied ? (
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
              </div>
              <p className="collaboration-collection-path-hint">
                {i18n.t('panels:ui.collection.folderHint')}
              </p>
            </div>
          ) : null}

          <div className="collaboration-collection-header">
            <div className="collaboration-collection-title-group">
              <span className="workspace-session-group-count">
                {items.length}
              </span>
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
                {i18n.t('panels:ui.collection.addText')}
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
                {i18n.t('panels:ui.collection.uploadFile')}
              </Button>
              <button
                type="button"
                className="collaboration-collection-delete-btn"
                data-testid="collaboration-collection-delete-btn"
                aria-label={i18n.t('panels:ui.collection.deleteSavedItem')}
                disabled={submitting || !selectedItemId}
                onClick={(event) => {
                  event.stopPropagation();
                  if (selectedItemId) {
                    void handleDeleteItem(selectedItemId);
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          {addFormOpen ? (
            <div
              className="collaboration-collection-add-form"
              data-testid="collaboration-collection-add-form"
            >
              <Input
                aria-label={i18n.t('panels:ui.collection.savedItemName')}
                value={textName}
                onChange={(event) => setTextName(event.target.value)}
                placeholder={i18n.t('panels:ui.collection.nameOptionalEGApi')}
                className="h-7 px-2 text-xs"
              />
              <Textarea
                aria-label={i18n.t('panels:ui.collection.savedTextContent')}
                value={textContent}
                onChange={(event) => setTextContent(event.target.value)}
                placeholder={i18n.t('panels:ui.collection.enterTextToSave')}
                rows={3}
                className="text-xs"
              />
              <Input
                aria-label={i18n.t('panels:ui.collection.savedItemNote')}
                value={noteInput}
                onChange={(event) => setNoteInput(event.target.value)}
                placeholder={i18n.t('panels:ui.collection.noteOptional')}
                className="h-7 px-2 text-xs"
              />
              <div className="flex justify-end gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setAddFormOpen(false)}
                >
                  {i18n.t('panels:ui.collection.cancel')}
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
                  {i18n.t('panels:ui.collection.addToGroupSaved')}
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
              <p className="collaboration-preview-empty">
                {i18n.t('panels:ui.collection.loading')}
              </p>
            ) : items.length === 0 ? (
              <p className="collaboration-preview-empty">
                {i18n.t('panels:ui.collection.nothingSavedInThisGroup')}
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
                    ? i18n.t('panels:ui.collection.image')
                    : itemKind === 'file'
                      ? i18n.t('panels:ui.collection.file')
                      : i18n.t('panels:ui.collection.text');
                const creatorIsPerson = isHumanPersonLabel(
                  item.creator_nickname
                );
                const creatorDisplay = creatorIsPerson
                  ? COPY.you
                  : item.creator_nickname;
                const creatorAvatarSeed = creatorIsPerson
                  ? 'Person'
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
                    data-selected={
                      selectedItemId === item.id ? 'true' : 'false'
                    }
                  >
                    <div
                      className="collaboration-collection-card-header"
                      onClick={() => {
                        setSelectedItemId(item.id);
                        toggleItemCollapsed(item.id);
                      }}
                    >
                      <div
                        className="collaboration-collection-creator"
                        data-testid={`collection-item-creator-${item.id}`}
                      >
                        <MemberBotAvatar
                          config={getAvatar(
                            item.creator_conversation_id,
                            creatorAvatarSeed
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
                        {itemKind === 'text' || itemKind === 'image' ? (
                          <button
                            type="button"
                            className="collaboration-collection-copy-btn"
                            data-testid={`collection-item-copy-${item.id}`}
                            aria-label={i18n.t(
                              'panels:ui.collection.copySavedItem'
                            )}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleCopyItem(item);
                            }}
                          >
                            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="collaboration-collection-delete-btn"
                          data-testid={`collection-item-delete-${item.id}`}
                          aria-label={i18n.t(
                            'panels:ui.collection.deleteSavedItem'
                          )}
                          disabled={submitting}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleDeleteItem(item.id);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="collaboration-collection-collapse-btn"
                          data-testid={`collection-item-collapse-toggle-${item.id}`}
                          aria-expanded={!isCollapsed}
                          aria-label={
                            isCollapsed
                              ? i18n.t('panels:ui.collection.expandSavedItem')
                              : i18n.t('panels:ui.collection.collapseSavedItem')
                          }
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
                            {i18n.t('panels:ui.collection.note')}
                          </span>
                          {isEditingNote ? (
                            <div className="collaboration-collection-note-editor">
                              <Input
                                aria-label={i18n.t(
                                  'panels:ui.collection.editSavedItemNote'
                                )}
                                data-testid={`collection-item-note-input-${item.id}`}
                                value={editingNoteDraft}
                                disabled={savingNoteItemId === item.id}
                                autoFocus
                                placeholder={i18n.t(
                                  'panels:ui.collection.enterANote'
                                )}
                                className="h-6 flex-1 px-2 text-xs"
                                onChange={(event) =>
                                  setEditingNoteDraft(event.target.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault();
                                    void handleSaveNote(
                                      item.id,
                                      editingNoteDraft
                                    );
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
                                aria-label={i18n.t(
                                  'panels:ui.collection.saveNote'
                                )}
                                data-testid={`collection-item-note-save-${item.id}`}
                                disabled={savingNoteItemId === item.id}
                                onClick={() => {
                                  void handleSaveNote(
                                    item.id,
                                    editingNoteDraft
                                  );
                                }}
                              >
                                <Check
                                  className="h-3.5 w-3.5"
                                  aria-hidden="true"
                                />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 shrink-0"
                                aria-label={i18n.t(
                                  'panels:ui.collection.cancelNoteEdit'
                                )}
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
                              aria-label={i18n.t(
                                'panels:ui.collection.editNote'
                              )}
                              title={i18n.t(
                                'panels:ui.collection.clickToEditNote'
                              )}
                              onClick={() => {
                                setEditingNoteItemId(item.id);
                                setEditingNoteDraft(item.note || '');
                              }}
                            >
                              <span>
                                {item.note ||
                                  i18n.t('panels:ui.collection.none')}
                              </span>
                              <Pencil
                                className="collaboration-collection-note-edit-icon h-3 w-3 shrink-0"
                                aria-hidden="true"
                              />
                            </button>
                          )}
                        </div>

                        <div className="collaboration-collection-card-footer">
                          <span data-testid={`collection-item-time-${item.id}`}>
                            {i18n.t('panels:ui.collection.createdAt', {
                              time: formatCollectionTime(item.created_at),
                            })}
                          </span>
                          <button
                            type="button"
                            className="collaboration-collection-reads-toggle"
                            data-testid={`collection-item-reads-toggle-${item.id}`}
                            aria-expanded={isReadsExpanded}
                            onClick={() => toggleReadLog(item.id)}
                          >
                            <span>
                              {i18n.t('panels:ui.collection.readsCount', {
                                count: itemReads.length,
                              })}
                            </span>
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
                                {i18n.t('panels:ui.collection.noBotReadsYet')}
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
                                      {i18n.t(
                                        'panels:ui.collection.readTimes',
                                        { count: read.read_count ?? 1 }
                                      )}{' '}
                                      ·{' '}
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
            <span>{i18n.t('panels:ui.collection.dragAFileHereOr')}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
