import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { type ContactGroup } from '../contactGroups';
import { type SidebarItem } from '../spaceModel';
import {
  EMPTY_CONVERSATIONS,
  EMPTY_MESSAGES,
  EMPTY_SCHEDULED,
  EMPTY_SPACES,
  type ThreadMessagesPage,
} from './types';

/** Effects own fetching. Queries only subscribe to cache written by those effects. */
const CACHE_ONLY_QUERY = {
  enabled: false as const,
  staleTime: Infinity,
  refetchOnMount: false as const,
  refetchOnReconnect: false as const,
  refetchOnWindowFocus: false as const,
};

export const collabQueryKeys = {
  spaces: (workspaceId: string) =>
    ['collaboration', 'spaces', workspaceId] as const,
  sidebar: (workspaceId: string) =>
    ['collaboration', 'sidebar', workspaceId] as const,
  contactGroups: (workspaceId: string) =>
    ['collaboration', 'contactGroups', workspaceId] as const,
  conversations: (workspaceId: string) =>
    ['collaboration', 'conversations', workspaceId] as const,
  membersBySpace: (workspaceId: string) =>
    ['collaboration', 'membersBySpace', workspaceId] as const,
  messagesBySpace: (workspaceId: string) =>
    ['collaboration', 'messagesBySpace', workspaceId] as const,
  thread: (threadId: string) =>
    ['collaboration', 'thread', threadId] as const,
};

export function setQueryDataValue<T>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  updater: T | ((current: T) => T),
  fallback: T
): void {
  queryClient.setQueryData<T>(queryKey, (current) => {
    const prev = current === undefined ? fallback : current;
    return typeof updater === 'function'
      ? (updater as (current: T) => T)(prev)
      : updater;
  });
}

export function useQueryDataSetter<T>(queryKey: QueryKey, fallback: T) {
  const queryClient = useQueryClient();
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  return useCallback(
    (updater: T | ((current: T) => T)) => {
      setQueryDataValue(
        queryClient,
        queryKeyRef.current,
        updater,
        fallbackRef.current
      );
    },
    [queryClient]
  );
}

export function useCollaborationCacheQuery<T>(queryKey: QueryKey, fallback: T) {
  return useQuery({
    queryKey,
    queryFn: () => fallback,
    ...CACHE_ONLY_QUERY,
    initialData: fallback,
  });
}

export function useCollaborationSpacesQuery(workspaceId: string) {
  return useCollaborationCacheQuery(
    collabQueryKeys.spaces(workspaceId),
    EMPTY_SPACES
  );
}

export function useCollaborationSidebarQuery(workspaceId: string) {
  return useCollaborationCacheQuery<SidebarItem[] | null>(
    collabQueryKeys.sidebar(workspaceId),
    null
  );
}

export function useCollaborationContactGroupsQuery(workspaceId: string) {
  return useCollaborationCacheQuery<ContactGroup[] | null>(
    collabQueryKeys.contactGroups(workspaceId),
    null
  );
}

export function useCollaborationConversationsQuery(workspaceId: string) {
  return useCollaborationCacheQuery(
    collabQueryKeys.conversations(workspaceId),
    EMPTY_CONVERSATIONS
  );
}

export function useCollaborationThreadQuery(threadId: string) {
  return useQuery({
    queryKey: collabQueryKeys.thread(threadId),
    queryFn: (): ThreadMessagesPage => ({
      messages: EMPTY_MESSAGES,
      scheduled: EMPTY_SCHEDULED,
    }),
    ...CACHE_ONLY_QUERY,
    gcTime: 0,
  });
}
