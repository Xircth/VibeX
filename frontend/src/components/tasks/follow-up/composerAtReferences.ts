import type { DbConversationSummary, GitLogEntry, Tag } from 'shared/types';
import { serializeTagReferenceMarker } from '@/lib/tagReferenceMarkers';
import { formatSessionComposerCommand } from './sessionComposerStructuredTokens';
import { matchTypeaheadTrigger } from './typeahead-triggers';

export const AT_REFERENCE_TAB_ORDER = [
  'file',
  'conversation',
  'commit',
  'instruction',
] as const;

export type AtReferenceTab = (typeof AT_REFERENCE_TAB_ORDER)[number];

export const MAX_AT_REFERENCES_PER_TAB = 50;

export type AtReferenceItem = {
  id: string;
  tab: AtReferenceTab;
  label: string;
  detail?: string;
  insertText: string;
};

export type AtReferenceGroup = {
  tab: AtReferenceTab;
  items: AtReferenceItem[];
  truncated: boolean;
};

export type AtReferenceSources = {
  files: Array<{ path: string; name: string }>;
  conversations: DbConversationSummary[];
  commits: GitLogEntry[];
  repoId: string | null;
  instructions: Tag[];
  currentConversationId?: string | null;
};

const CONVERSATION_URI_PREFIX = 'vibex://conversation/';
const COMMIT_URI_PREFIX = 'vibex://commit/';

export function conversationReferenceUri(conversationId: string): string {
  return `${CONVERSATION_URI_PREFIX}${conversationId}`;
}

export function commitReferenceUri(repoId: string, sha: string): string {
  return `${COMMIT_URI_PREFIX}${encodeURIComponent(repoId)}@${sha}`;
}

export function parseConversationReferenceUri(uri: string): string | null {
  if (!uri.toLowerCase().startsWith(CONVERSATION_URI_PREFIX)) return null;
  const id = uri.slice(CONVERSATION_URI_PREFIX.length).trim();
  return id || null;
}

export function parseCommitReferenceUri(
  uri: string
): { repoId: string; sha: string } | null {
  if (!uri.toLowerCase().startsWith(COMMIT_URI_PREFIX)) return null;
  const body = uri.slice(COMMIT_URI_PREFIX.length);
  const separator = body.lastIndexOf('@');
  if (separator <= 0 || separator === body.length - 1) return null;
  try {
    const repoId = decodeURIComponent(body.slice(0, separator));
    const sha = body.slice(separator + 1);
    if (!repoId || !sha) return null;
    return { repoId, sha };
  } catch {
    return null;
  }
}

export function shortCommitSha(sha: string): string {
  return sha.slice(0, 7);
}

function matchesQuery(
  query: string,
  ...fields: Array<string | null | undefined>
) {
  if (!query) return true;
  return fields.some((field) => field?.toLowerCase().includes(query));
}

function capItems(items: AtReferenceItem[]): {
  items: AtReferenceItem[];
  truncated: boolean;
} {
  return {
    items: items.slice(0, MAX_AT_REFERENCES_PER_TAB),
    truncated: items.length > MAX_AT_REFERENCES_PER_TAB,
  };
}

export function fileToAtReference(file: {
  path: string;
  name: string;
}): AtReferenceItem {
  const name = file.name || file.path.split(/[\\/]/).pop() || file.path;
  return {
    id: `file:${file.path}`,
    tab: 'file',
    label: name,
    detail: file.path,
    insertText: formatSessionComposerCommand({
      type: '@',
      key: name,
      value: file.path,
    }),
  };
}

export function conversationToAtReference(
  conversation: DbConversationSummary
): AtReferenceItem {
  const title = conversation.title?.trim() || conversation.id;
  return {
    id: `conversation:${conversation.id}`,
    tab: 'conversation',
    label: title,
    detail: conversation.agent_id ?? conversation.status,
    insertText: `[${title.replace(/[\\\]]/g, '\\$&')}](${conversationReferenceUri(
      conversation.id
    )})`,
  };
}

export function commitToAtReference(
  entry: GitLogEntry,
  repoId: string
): AtReferenceItem {
  const shortSha = shortCommitSha(entry.sha);
  return {
    id: `commit:${entry.sha}`,
    tab: 'commit',
    label: shortSha,
    detail: entry.summary,
    insertText: `[${shortSha}](${commitReferenceUri(repoId, entry.sha)})`,
  };
}

export function instructionToAtReference(tag: Tag): AtReferenceItem {
  return {
    id: `instruction:${tag.id}`,
    tab: 'instruction',
    label: `#${tag.tag_name}`,
    detail: tag.content || undefined,
    insertText: formatSessionComposerCommand({
      type: '#',
      key: tag.tag_name,
      value: serializeTagReferenceMarker({
        tagId: tag.id,
        tagName: tag.tag_name,
        content: tag.content ?? '',
      }),
    }),
  };
}

export function buildAtReferenceGroups(
  query: string,
  sources: AtReferenceSources
): AtReferenceGroup[] {
  const q = query.trim().toLowerCase();
  const currentId = sources.currentConversationId ?? null;

  const files = sources.files
    .filter((file) => matchesQuery(q, file.name, file.path))
    .map(fileToAtReference);

  const conversations = sources.conversations
    .filter((conversation) => conversation.id !== currentId)
    .filter((conversation) =>
      matchesQuery(
        q,
        conversation.title,
        conversation.id,
        conversation.agent_id,
        conversation.status
      )
    )
    .map(conversationToAtReference);

  const commits = sources.repoId
    ? sources.commits
        .filter((entry) =>
          matchesQuery(
            q,
            entry.sha,
            shortCommitSha(entry.sha),
            entry.summary,
            entry.author
          )
        )
        .map((entry) => commitToAtReference(entry, sources.repoId as string))
    : [];

  const instructions = sources.instructions
    .filter((tag) => matchesQuery(q, tag.tag_name, tag.content))
    .map(instructionToAtReference);

  return [
    { tab: 'file', ...capItems(files) },
    { tab: 'conversation', ...capItems(conversations) },
    { tab: 'commit', ...capItems(commits) },
    { tab: 'instruction', ...capItems(instructions) },
  ];
}

export function firstNonEmptyTab(
  groups: AtReferenceGroup[],
  pinned?: AtReferenceTab | null
): AtReferenceTab {
  if (pinned && AT_REFERENCE_TAB_ORDER.includes(pinned)) return pinned;
  return (
    AT_REFERENCE_TAB_ORDER.find(
      (tab) =>
        (groups.find((group) => group.tab === tab)?.items.length ?? 0) > 0
    ) ?? AT_REFERENCE_TAB_ORDER[0]
  );
}

export function cycleAtReferenceTab(
  current: AtReferenceTab,
  direction: 1 | -1
): AtReferenceTab {
  const at = AT_REFERENCE_TAB_ORDER.indexOf(current);
  const index = at < 0 ? 0 : at;
  return AT_REFERENCE_TAB_ORDER[
    (index + direction + AT_REFERENCE_TAB_ORDER.length) %
      AT_REFERENCE_TAB_ORDER.length
  ];
}

export function matchAtReferenceTrigger(text: string) {
  return matchTypeaheadTrigger(text, '@', '#@');
}
