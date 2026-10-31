import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { type IDockviewPanelProps } from 'dockview-react';
import {
  Bookmark,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  Copy,
  History,
  Link2,
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

export type SpaceMemoryFactRecord = {
  id: number;
  memberId?: string;
  member_id?: string;
  content: string;
  scope: string;
  sourceThreadId?: string | null;
  source_thread_id?: string | null;
  origin: string;
  updatedAt?: string;
  updated_at?: string;
};

export type SpaceMemoryTopicRecord = {
  topic: string;
  title: string;
  summary?: string;
  preview?: string;
  content?: string;
  charCount?: number;
  char_count?: number;
  byteSize?: number;
  byte_size?: number;
  updatedAt?: string;
  updated_at?: string;
  filePath?: string;
  file_path?: string;
};

export type SpaceMemoryJournalRecord = {
  id: string;
  ts: string;
  spaceId?: string;
  actor: string;
  op: string;
  scope: string;
  target: string;
  before?: string | null;
  after?: string | null;
};

export type SpaceMemorySummarySection = {
  id: string;
  title: string;
  items: string[];
};

export type SpaceMemorySummaryCard = {
  sections: SpaceMemorySummarySection[];
  charCount?: number;
  char_count?: number;
  budgetChars?: number;
  budget_chars?: number;
  updatedAt?: string;
  updated_at?: string;
};

export type SpaceMemoryViewPayload = {
  spaceId?: string;
  memberId?: string | null;
  memoryFilePath?: string;
  memory_file_path?: string;
  summary?: SpaceMemorySummaryCard;
  facts?: SpaceMemoryFactRecord[];
  topics?: SpaceMemoryTopicRecord[];
  journal?: SpaceMemoryJournalRecord[];
  excludedCollectionIds?: string[];
  excluded_collection_ids?: string[];
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

function formatScopeLabel(scope: string): string {
  if (scope === 'global') return '全局';
  if (scope === 'private') return '私聊';
  if (scope.startsWith('thread:')) return '本群';
  return scope;
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
  const [liveSpaceAvatars, setLiveSpaceAvatars] = useState<
    MemberBotAvatarConfig[] | null
  >(null);

  // Unified Assets state (memory | topics | collection)
  const [assetTab, setAssetTab] = useState<'memory' | 'topics' | 'collection'>(
    'memory'
  );
  const [showJournal, setShowJournal] = useState(false);
  const [memorySummary, setMemorySummary] =
    useState<SpaceMemorySummaryCard | null>(null);
  const [memoryFacts, setMemoryFacts] = useState<SpaceMemoryFactRecord[]>([]);
  const [memoryTopics, setMemoryTopics] = useState<SpaceMemoryTopicRecord[]>(
    []
  );
  const [memoryJournal, setMemoryJournal] = useState<
    SpaceMemoryJournalRecord[]
  >([]);
  const [excludedCollectionIds, setExcludedCollectionIds] = useState<string[]>(
    []
  );
  const [addFactOpen, setAddFactOpen] = useState(false);
  const [newFactContent, setNewFactContent] = useState('');
  const [newFactScope, setNewFactScope] = useState<string>(
    isAssistant ? 'private' : 'thread'
  );
  const [editingFactId, setEditingFactId] = useState<number | null>(null);
  const [editingFactDraft, setEditingFactDraft] = useState('');
  const [addTopicOpen, setAddTopicOpen] = useState(false);
  const [topicSlugInput, setTopicSlugInput] = useState('');
  const [topicTitleInput, setTopicTitleInput] = useState('');
  const [topicContentInput, setTopicContentInput] = useState('');
  const [expandedTopicSlugs, setExpandedTopicSlugs] = useState<Set<string>>(
    () => new Set()
  );

  const spaceTagPreset = useMemo(() => {
    const colorId = paramTagColorId ?? readSpaceTags()[spaceId]?.colorId;
    return colorId
      ? SPACE_TAG_PRESETS.find((preset) => preset.id === colorId)
      : undefined;
  }, [paramTagColorId, spaceId]);

  const getAvatar = useCallback(
    (
      cid?: string | null,
      nickname?: string,
      identityMemberId?: string | null
    ): MemberBotAvatarConfig =>
      resolveMemberBotAvatar({
        conversationId: cid,
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

  const applyMemoryViewPayload = useCallback(
    (view: SpaceMemoryViewPayload | null | undefined) => {
      if (!view || typeof view !== 'object') return;
      if (view.summary) setMemorySummary(view.summary);
      if (Array.isArray(view.facts)) setMemoryFacts(view.facts);
      if (Array.isArray(view.topics)) setMemoryTopics(view.topics);
      if (Array.isArray(view.journal)) setMemoryJournal(view.journal);
      const excluded =
        view.excludedCollectionIds ?? view.excluded_collection_ids;
      if (Array.isArray(excluded)) setExcludedCollectionIds(excluded);
    },
    []
  );

  const loadMemory = useCallback(async () => {
    if (!spaceId) return;
    try {
      const view = await collaborationCall<SpaceMemoryViewPayload>(
        'collaboration',
        'space.memory.view',
        {
          spaceId,
          memberId: memberId || undefined,
        }
      );
      applyMemoryViewPayload(view);
    } catch {
      // Silently ignore when backend / test mock does not implement space.memory.view
    }
  }, [applyMemoryViewPayload, memberId, spaceId]);

  const loadCollection = useCallback(async () => {
    if (!spaceId) return;
    try {
      const response = await collaborationCall<{
        items?: SpaceCollectionItemRecord[];
      }>('collaboration', 'space.listCollection', { spaceId });
      setItems(response?.items ?? []);
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    setLoading(true);
    void loadCollection();
    void loadMemory();
  }, [loadCollection, loadMemory]);

  useEffect(() => {
    if (detailsTab !== 'collection' || !spaceId) return;
    const timer = window.setInterval(() => {
      void loadCollection();
      void loadMemory();
    }, COLLECTION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [detailsTab, loadCollection, loadMemory, spaceId]);

  useEffect(() => {
    if (!spaceId) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenCollaborationSpaceChanged((payload) => {
      const event = parseSpaceChangedEvent(payload);
      if (!active || !event || event.spaceId !== spaceId) return;
      void loadCollection();
      void loadMemory();
    }).then((stop) => {
      if (!active) stop();
      else unlisten = stop;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [loadCollection, loadMemory, spaceId]);

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

  const toggleTopicExpanded = useCallback((topicSlug: string) => {
    setExpandedTopicSlugs((current) => {
      const next = new Set(current);
      if (next.has(topicSlug)) {
        next.delete(topicSlug);
      } else {
        next.add(topicSlug);
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
        await loadMemory();
      } catch (cause) {
        setError(surfaceErrorCopy(cause));
      } finally {
        setSavingNoteItemId(null);
      }
    },
    [loadCollection, loadMemory, savingNoteItemId, spaceId]
  );

  const handleToggleCollectionIndexed = useCallback(
    async (itemId: string) => {
      if (!spaceId || !itemId) return;
      try {
        const res = await collaborationCall<{
          excludedCollectionIds?: string[];
        }>('collaboration', 'space.memory.toggleCollectionIndex', {
          spaceId,
          memberId: memberId || undefined,
          itemId,
        });
        if (res && Array.isArray(res.excludedCollectionIds)) {
          setExcludedCollectionIds(res.excludedCollectionIds);
        }
        await loadMemory();
      } catch (cause) {
        setError(surfaceErrorCopy(cause));
      }
    },
    [loadMemory, memberId, spaceId]
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
        await loadMemory();
      } catch (cause) {
        setError(surfaceErrorCopy(cause));
      } finally {
        setSubmitting(false);
      }
    },
    [loadMemory, spaceId, submitting]
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
      await loadMemory();
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddFactSubmit = async () => {
    const trimmed = newFactContent.trim();
    if (!trimmed || !spaceId || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await collaborationCall<{
        fact?: SpaceMemoryFactRecord;
        view?: SpaceMemoryViewPayload;
      }>('collaboration', 'space.memory.add', {
        spaceId,
        memberId: memberId || undefined,
        content: trimmed,
        scope: newFactScope,
      });
      if (res?.view) {
        applyMemoryViewPayload(res.view);
      } else {
        await loadMemory();
      }
      setNewFactContent('');
      setAddFactOpen(false);
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveFactEdit = async (factId: number) => {
    const trimmed = editingFactDraft.trim();
    if (!trimmed || !spaceId || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await collaborationCall('collaboration', 'space.memory.update', {
        spaceId,
        memberId: memberId || undefined,
        factId,
        content: trimmed,
      });
      setEditingFactId(null);
      setEditingFactDraft('');
      await loadMemory();
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteFact = async (factId: number) => {
    if (!spaceId || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await collaborationCall('collaboration', 'space.memory.delete', {
        spaceId,
        memberId: memberId || undefined,
        factId,
      });
      setMemoryFacts((current) => current.filter((f) => f.id !== factId));
      await loadMemory();
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddTopicSubmit = async () => {
    const slug = topicSlugInput.trim();
    const body = topicContentInput.trim();
    if (!slug || !body || !spaceId || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await collaborationCall('collaboration', 'space.memory.writeTopic', {
        spaceId,
        memberId: memberId || undefined,
        topic: slug,
        title: topicTitleInput.trim() || undefined,
        content: body,
      });
      setTopicSlugInput('');
      setTopicTitleInput('');
      setTopicContentInput('');
      setAddTopicOpen(false);
      await loadMemory();
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteTopic = async (topicSlug: string) => {
    if (!spaceId || !topicSlug || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await collaborationCall('collaboration', 'space.memory.deleteTopic', {
        spaceId,
        memberId: memberId || undefined,
        topic: topicSlug,
      });
      setMemoryTopics((current) =>
        current.filter((t) => t.topic !== topicSlug)
      );
      await loadMemory();
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
        await loadMemory();
      } catch (cause) {
        setError(surfaceErrorCopy(cause));
      } finally {
        setSubmitting(false);
      }
    },
    [loadCollection, loadMemory, noteInput, projectId, spaceId]
  );

  const handleAddSourcePath = useCallback(
    async (fullPath: string, displayNameValue?: string) => {
      if (!spaceId || !fullPath) return;
      setSubmitting(true);
      setError('');
      try {
        const name =
          displayNameValue ||
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
        await loadMemory();
      } catch (cause) {
        setError(surfaceErrorCopy(cause));
      } finally {
        setSubmitting(false);
      }
    },
    [loadCollection, loadMemory, noteInput, projectId, spaceId]
  );

  const charCount =
    memorySummary?.charCount ??
    memorySummary?.char_count ??
    memoryFacts.reduce((acc, f) => acc + f.content.length, 0);
  const budgetChars =
    memorySummary?.budgetChars ?? memorySummary?.budget_chars ?? 4000;
  const isNearBudget = charCount >= budgetChars * 0.85;

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
          setAssetTab('collection');
          void handleAddFiles(droppedFiles);
          return;
        }
        const rawRef =
          event.dataTransfer?.getData(FILE_REFERENCE_DRAG_MIME) ?? '';
        const fileRef =
          parseFileReferencePayload(rawRef) ?? getCurrentDraggedFileReference();
        clearCurrentDraggedFileReference();
        if (fileRef && fileRef.kind === 'file' && workspacePath) {
          setAssetTab('collection');
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
            'collaboration-group-details-body collaboration-assets-body',
            isAssistant && 'collaboration-assistant-details-body'
          )}
        >
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
                setAssetTab('collection');
                void handleAddFiles(files);
              }
            }}
          />

          <div
            className="collaboration-assets-toolbar"
            data-testid="collaboration-assets-toolbar"
          >
            <SegmentedControl
              value={assetTab}
              onChange={(val) => {
                setAssetTab(val as 'memory' | 'topics' | 'collection');
                setShowJournal(false);
              }}
              label="资产分类"
              size="sm"
              className="collaboration-compact-segmented collaboration-assets-segmented"
              data-testid="collaboration-assets-segmented"
            >
              <SegmentedControlItem
                value="memory"
                label="记忆"
                icon={<Brain className="h-3.5 w-3.5" aria-hidden="true" />}
                data-testid="collaboration-assets-tab-memory"
              />
              <SegmentedControlItem
                value="topics"
                label="主题"
                icon={<BookOpen className="h-3.5 w-3.5" aria-hidden="true" />}
                data-testid="collaboration-assets-tab-topics"
              />
              <SegmentedControlItem
                value="collection"
                label="收藏"
                icon={<Bookmark className="h-3.5 w-3.5" aria-hidden="true" />}
                data-testid="collaboration-assets-tab-collection"
              />
            </SegmentedControl>

            <div className="collaboration-assets-toolbar-actions">
              {assetTab === 'memory' ? (
                <>
                  <span
                    className={cn(
                      'collaboration-memory-budget-badge',
                      isNearBudget && 'is-warning'
                    )}
                    data-testid="collaboration-memory-budget"
                  >
                    {charCount} / {budgetChars}
                  </span>
                  <button
                    type="button"
                    className={cn(
                      'collaboration-assets-icon-btn',
                      showJournal && 'is-active'
                    )}
                    data-testid="collaboration-memory-journal-toggle"
                    aria-label="变更记录"
                    title="变更记录"
                    onClick={() => setShowJournal((current) => !current)}
                  >
                    <History className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={submitting}
                    className="collaboration-collection-action-btn"
                    data-testid="collaboration-memory-add-fact-toggle"
                    onClick={() => setAddFactOpen((current) => !current)}
                  >
                    <Plus className="mr-1 h-3 w-3" aria-hidden="true" />
                    添加
                  </Button>
                </>
              ) : assetTab === 'topics' ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={submitting}
                  className="collaboration-collection-action-btn"
                  data-testid="collaboration-memory-add-topic-toggle"
                  onClick={() => setAddTopicOpen((current) => !current)}
                >
                  <Plus className="mr-1 h-3 w-3" aria-hidden="true" />
                  新建
                </Button>
              ) : (
                <>
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
                </>
              )}
            </div>
          </div>

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
            {assetTab === 'memory' && addFactOpen ? (
              <div
                className="collaboration-collection-add-form"
                data-testid="collaboration-memory-add-fact-form"
              >
                <Textarea
                  aria-label="记忆内容"
                  value={newFactContent}
                  onChange={(event) => setNewFactContent(event.target.value)}
                  placeholder="输入长期记忆或协作偏好…"
                  rows={2}
                  className="min-h-[64px] px-2.5 py-1.5 text-xs"
                  data-testid="collaboration-memory-fact-input"
                />
                <div className="flex items-center justify-between gap-2">
                  {isAssistant ? (
                    <div className="flex items-center gap-1.5 text-xs">
                      <button
                        type="button"
                        className={cn(
                          'collaboration-memory-scope-chip',
                          newFactScope === 'private' && 'is-active'
                        )}
                        onClick={() => setNewFactScope('private')}
                      >
                        私聊
                      </button>
                      <button
                        type="button"
                        className={cn(
                          'collaboration-memory-scope-chip',
                          newFactScope === 'global' && 'is-active'
                        )}
                        onClick={() => setNewFactScope('global')}
                      >
                        全局
                      </button>
                    </div>
                  ) : (
                    <span />
                  )}
                  <div className="flex justify-end gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setAddFactOpen(false)}
                    >
                      {i18n.t('panels:ui.collection.cancel')}
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      size="xs"
                      disabled={!newFactContent.trim() || submitting}
                      data-testid="collaboration-memory-submit-fact-btn"
                      onClick={() => {
                        void handleAddFactSubmit();
                      }}
                    >
                      保存
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            {assetTab === 'topics' && addTopicOpen ? (
              <div
                className="collaboration-collection-add-form"
                data-testid="collaboration-memory-add-topic-form"
              >
                <div className="flex gap-1.5">
                  <Input
                    aria-label="主题标识"
                    value={topicSlugInput}
                    onChange={(event) => setTopicSlugInput(event.target.value)}
                    placeholder="标识 (如 mail-templates)"
                    className="h-7 flex-1 px-2 text-xs"
                    data-testid="collaboration-memory-topic-slug-input"
                  />
                  <Input
                    aria-label="主题标题"
                    value={topicTitleInput}
                    onChange={(event) => setTopicTitleInput(event.target.value)}
                    placeholder="标题 (可选)"
                    className="h-7 flex-1 px-2 text-xs"
                    data-testid="collaboration-memory-topic-title-input"
                  />
                </div>
                <Textarea
                  aria-label="主题内容"
                  value={topicContentInput}
                  onChange={(event) =>
                    setTopicContentInput(event.target.value)
                  }
                  placeholder="输入主题内容…"
                  rows={4}
                  className="text-xs"
                  data-testid="collaboration-memory-topic-content-input"
                />
                <div className="flex justify-end gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setAddTopicOpen(false)}
                  >
                    {i18n.t('panels:ui.collection.cancel')}
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    size="xs"
                    disabled={
                      !topicSlugInput.trim() ||
                      !topicContentInput.trim() ||
                      submitting
                    }
                    data-testid="collaboration-memory-submit-topic-btn"
                    onClick={() => {
                      void handleAddTopicSubmit();
                    }}
                  >
                    保存
                  </Button>
                </div>
              </div>
            ) : null}

            {assetTab === 'collection' && addFormOpen ? (
              <div
                className="collaboration-collection-add-form"
                data-testid="collaboration-collection-add-form"
              >
                <Input
                  aria-label={i18n.t('panels:ui.collection.savedItemName')}
                  value={textName}
                  onChange={(event) => setTextName(event.target.value)}
                  placeholder={i18n.t(
                    'panels:ui.collection.nameOptionalEGApi'
                  )}
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
            {assetTab === 'memory' ? (
              showJournal ? (
                <section
                  className="collaboration-memory-facts-card"
                  data-testid="collaboration-memory-journal-section"
                >
                  {memoryJournal.length === 0 ? (
                    <div className="collaboration-assets-empty">
                      <History
                        className="h-5 w-5 opacity-40"
                        aria-hidden="true"
                      />
                      <span>暂无变更记录</span>
                    </div>
                  ) : (
                    <div
                      className="collaboration-memory-journal-list"
                      data-testid="collaboration-memory-journal-list"
                    >
                      {memoryJournal.map((entry, idx) => (
                        <div
                          key={entry.id ?? `${entry.ts}-${idx}`}
                          className="collaboration-memory-journal-row"
                        >
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                            <span>
                              {entry.op.toUpperCase()}
                              {entry.target ? ` · ${entry.target}` : ''}
                            </span>
                            <span className="tabular-nums">
                              {formatCollectionTime(entry.ts)}
                            </span>
                          </div>
                          {entry.before ? (
                            <div className="text-xs text-muted-foreground line-through">
                              {entry.before}
                            </div>
                          ) : null}
                          {entry.after ? (
                            <div className="text-xs text-foreground">
                              {entry.after}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              ) : memoryFacts.length > 0 ? (
                <section
                  className="collaboration-memory-facts-card"
                  data-testid="collaboration-memory-facts-section"
                >
                  <div
                    className="collaboration-memory-fact-list"
                    data-testid="collaboration-memory-fact-list"
                  >
                    {memoryFacts.map((fact) => {
                      const isEditing = editingFactId === fact.id;
                      return (
                        <div
                          key={fact.id}
                          className="collaboration-memory-fact-row"
                          data-testid={`memory-fact-item-${fact.id}`}
                        >
                          {isEditing ? (
                            <div className="collaboration-collection-note-editor">
                              <Input
                                aria-label="编辑记忆内容"
                                data-testid={`memory-fact-edit-input-${fact.id}`}
                                value={editingFactDraft}
                                autoFocus
                                className="h-6 flex-1 px-2 text-xs"
                                onChange={(event) =>
                                  setEditingFactDraft(event.target.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault();
                                    void handleSaveFactEdit(fact.id);
                                  } else if (event.key === 'Escape') {
                                    event.preventDefault();
                                    setEditingFactId(null);
                                  }
                                }}
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 shrink-0"
                                aria-label="保存记忆修改"
                                data-testid={`memory-fact-save-${fact.id}`}
                                onClick={() => {
                                  void handleSaveFactEdit(fact.id);
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
                                aria-label="取消修改"
                                onClick={() => setEditingFactId(null)}
                              >
                                <X
                                  className="h-3.5 w-3.5"
                                  aria-hidden="true"
                                />
                              </Button>
                            </div>
                          ) : (
                            <>
                              <div className="collaboration-memory-fact-main">
                                <p className="collaboration-memory-fact-text">
                                  {fact.content}
                                </p>
                                <div className="collaboration-memory-fact-meta">
                                  <span className="collaboration-memory-scope-badge">
                                    {formatScopeLabel(fact.scope)}
                                  </span>
                                  <span>
                                    {formatCollectionTime(
                                      fact.updatedAt ?? fact.updated_at ?? ''
                                    )}
                                  </span>
                                </div>
                              </div>
                              <div className="collaboration-memory-fact-actions">
                                <button
                                  type="button"
                                  className="collaboration-collection-copy-btn"
                                  aria-label="编辑记忆"
                                  data-testid={`memory-fact-edit-${fact.id}`}
                                  onClick={() => {
                                    setEditingFactId(fact.id);
                                    setEditingFactDraft(fact.content);
                                  }}
                                >
                                  <Pencil
                                    className="h-3 w-3"
                                    aria-hidden="true"
                                  />
                                </button>
                                <button
                                  type="button"
                                  className="collaboration-collection-delete-btn"
                                  aria-label="删除记忆"
                                  data-testid={`memory-fact-delete-${fact.id}`}
                                  onClick={() => {
                                    void handleDeleteFact(fact.id);
                                  }}
                                >
                                  <Trash2
                                    className="h-3 w-3"
                                    aria-hidden="true"
                                  />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : memorySummary && memorySummary.sections.length > 0 ? (
                <section
                  className="collaboration-memory-summary-card"
                  data-testid="collaboration-memory-summary-card"
                >
                  <div className="collaboration-memory-summary-sections">
                    {memorySummary.sections.map((sec) => (
                      <div
                        key={sec.id}
                        className="collaboration-memory-summary-section"
                      >
                        <h4 className="collaboration-memory-summary-section-title">
                          {sec.title}
                        </h4>
                        <ul className="collaboration-memory-summary-bullets">
                          {sec.items.map((bullet, idx) => (
                            <li key={idx}>{bullet}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </section>
              ) : (
                <div className="collaboration-assets-empty">
                  <Brain className="h-5 w-5 opacity-40" aria-hidden="true" />
                  <span>暂无记忆</span>
                </div>
              )
            ) : assetTab === 'topics' ? (
              memoryTopics.length > 0 ? (
                <section
                  className="collaboration-memory-facts-card"
                  data-testid="collaboration-memory-topics-section"
                >
                  <div
                    className="collaboration-memory-topic-list"
                    data-testid="collaboration-memory-topic-list"
                  >
                    {memoryTopics.map((topicItem) => {
                      const isExpanded = expandedTopicSlugs.has(
                        topicItem.topic
                      );
                      const topicSummary =
                        topicItem.summary ?? topicItem.preview ?? '';
                      const topicBody = topicItem.content ?? topicSummary;
                      return (
                        <div
                          key={topicItem.topic}
                          className="collaboration-memory-topic-card"
                          data-testid={`memory-topic-item-${topicItem.topic}`}
                        >
                          <div
                            className="collaboration-memory-topic-header"
                            onClick={() =>
                              toggleTopicExpanded(topicItem.topic)
                            }
                          >
                            <div className="collaboration-memory-topic-title-wrap">
                              <span className="truncate font-medium">
                                {topicItem.title}
                              </span>
                              <span className="collaboration-memory-topic-chip">
                                #{topicItem.topic}
                              </span>
                            </div>
                            <div className="collaboration-collection-card-header-right">
                              <span className="text-[11px] text-muted-foreground tabular-nums">
                                {topicItem.charCount ??
                                  topicItem.char_count ??
                                  topicBody.length}{' '}
                                字
                              </span>
                              <button
                                type="button"
                                className="collaboration-collection-copy-btn"
                                aria-label="编辑主题"
                                data-testid={`memory-topic-edit-${topicItem.topic}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setTopicSlugInput(topicItem.topic);
                                  setTopicTitleInput(topicItem.title);
                                  setTopicContentInput(topicBody);
                                  setAddTopicOpen(true);
                                }}
                              >
                                <Pencil
                                  className="h-3 w-3"
                                  aria-hidden="true"
                                />
                              </button>
                              <button
                                type="button"
                                className="collaboration-collection-delete-btn"
                                aria-label="删除主题"
                                data-testid={`memory-topic-delete-${topicItem.topic}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleDeleteTopic(topicItem.topic);
                                }}
                              >
                                <Trash2
                                  className="h-3 w-3"
                                  aria-hidden="true"
                                />
                              </button>
                              <ChevronDown
                                className={cn(
                                  'h-3.5 w-3.5 transition-transform text-muted-foreground',
                                  !isExpanded && '-rotate-90'
                                )}
                                aria-hidden="true"
                              />
                            </div>
                          </div>
                          {!isExpanded ? (
                            <p className="collaboration-memory-topic-summary">
                              {topicSummary}
                            </p>
                          ) : (
                            <div
                              className="collaboration-collection-text-content mt-1.5"
                              data-testid={`memory-topic-content-${topicItem.topic}`}
                            >
                              {topicBody}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : (
                <div className="collaboration-assets-empty">
                  <BookOpen className="h-5 w-5 opacity-40" aria-hidden="true" />
                  <span>暂无主题</span>
                </div>
              )
            ) : loading ? (
              <p className="collaboration-preview-empty">
                {i18n.t('panels:ui.collection.loading')}
              </p>
            ) : items.length === 0 ? (
              <div className="collaboration-assets-empty">
                <Bookmark className="h-5 w-5 opacity-40" aria-hidden="true" />
                <span>
                  {i18n.t('panels:ui.collection.nothingSavedInThisGroup')}
                </span>
              </div>
            ) : (
              items.map((item) => {
                const isCollapsed = collapsedItemIds.has(item.id);
                const isReadsExpanded = expandedReadItemIds.has(item.id);
                const isEditingNote = editingNoteItemId === item.id;
                const isIndexedInMemory = !excludedCollectionIds.includes(
                  item.id
                );
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
                            <Copy
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
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
                          <Trash2
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                        </button>
                        <button
                          type="button"
                          className="collaboration-collection-collapse-btn"
                          data-testid={`collection-item-collapse-toggle-${item.id}`}
                          aria-expanded={!isCollapsed}
                          aria-label={
                            isCollapsed
                              ? i18n.t('panels:ui.collection.expandSavedItem')
                              : i18n.t(
                                  'panels:ui.collection.collapseSavedItem'
                                )
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
                                <X
                                  className="h-3.5 w-3.5"
                                  aria-hidden="true"
                                />
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
                          <span
                            data-testid={`collection-item-time-${item.id}`}
                          >
                            {formatCollectionTime(item.created_at)}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              className={cn(
                                'collaboration-memory-index-toggle',
                                isIndexedInMemory && 'is-indexed'
                              )}
                              data-testid={`collection-item-index-toggle-${item.id}`}
                              title={
                                isIndexedInMemory
                                  ? '已同步至记忆索引，点击取消'
                                  : '点击加入记忆索引'
                              }
                              onClick={() => {
                                void handleToggleCollectionIndexed(item.id);
                              }}
                            >
                              <Link2
                                className="h-3 w-3 shrink-0"
                                aria-hidden="true"
                              />
                              <span>
                                {isIndexedInMemory ? '已索引' : '索引'}
                              </span>
                            </button>
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
                                        read.last_read_at ??
                                          read.read_at ??
                                          ''
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

          {assetTab === 'collection' ? (
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
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
