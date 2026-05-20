import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { $createTextNode } from 'lexical';
import type { Repo } from 'shared/types';

import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { useTypeaheadOpen } from '@/components/ui/wysiwyg/context/typeahead-open-context';
import { fileTreeApi, repoApi } from '@/lib/api';
import {
  searchTagsAndFiles,
  type SearchResultItem,
} from '@/lib/searchTagsAndFiles';
import { useUiPreferencesStore } from '@/stores/useUiPreferencesStore';

import { $createFileReferenceNode } from '../nodes/file-reference-node';
import { $createTagReferenceNode } from '../nodes/tag-reference-node';
import { TypeaheadMenu } from './typeahead-menu-components';
import {
  matchFileReferenceTrigger,
  matchTagReferenceTrigger,
} from './typeahead-triggers';

type Trigger = '#' | '@';

class FileTagOption extends MenuOption {
  item: SearchResultItem | null;
  meta: 'loading' | 'empty' | null;

  constructor(
    item: SearchResultItem | null,
    meta: 'loading' | 'empty' | null = null
  ) {
    const key =
      item === null
        ? `file-tag-meta-${meta}`
        : item.type === 'tag'
          ? `tag-${item.tag!.id}`
          : `file-${item.file!.path}`;
    super(key);
    this.item = item;
    this.meta = meta;
  }
}

const MAX_FILE_RESULTS = 10;

interface DiffFileResult {
  path: string;
  name: string;
  is_file: boolean;
  match_type: 'FileName' | 'DirectoryName' | 'FullPath';
  score: bigint;
}

function getMatchingDiffFiles(
  query: string,
  diffPaths: Set<string>
): DiffFileResult[] {
  if (!query) return [];
  const lowerQuery = query.toLowerCase();
  return Array.from(diffPaths)
    .filter((path) => {
      const name = path.split('/').pop() || path;
      return (
        name.toLowerCase().includes(lowerQuery) ||
        path.toLowerCase().includes(lowerQuery)
      );
    })
    .map((path) => {
      const name = path.split('/').pop() || path;
      const nameMatches = name.toLowerCase().includes(lowerQuery);
      return {
        path,
        name,
        is_file: true,
        match_type: nameMatches ? ('FileName' as const) : ('FullPath' as const),
        score: BigInt(Number.MAX_SAFE_INTEGER),
      };
    });
}

function getRepoDisplayName(repo: Repo): string {
  return repo.display_name || repo.name;
}

function createInitialFileOption(path: string, kind: 'file' | 'directory') {
  const name = path.split('/').pop() || path;
  return new FileTagOption({
    type: 'file',
    file: {
      path,
      name,
      is_file: kind === 'file',
      match_type: 'FullPath',
      score: BigInt(0),
    },
  });
}

export function FileTagTypeaheadPlugin({
  trigger,
  repoIds,
  projectId,
}: {
  trigger: Trigger;
  repoIds?: string[];
  projectId?: string;
}) {
  const isTagTrigger = trigger === '#';
  const isFileTrigger = trigger === '@';
  const [editor] = useLexicalComposerContext();
  const [options, setOptions] = useState<FileTagOption[]>([]);
  const [recentRepoCatalog, setRecentRepoCatalog] = useState<Repo[] | null>(
    null
  );
  const [preferredRepoName, setPreferredRepoName] = useState<string | null>(
    null
  );
  const [showMissingRepoState, setShowMissingRepoState] = useState(false);
  const [isChoosingRepo, setIsChoosingRepo] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [activeQuery, setActiveQuery] = useState<string | null>(null);
  const portalContainer = usePortalContainer();
  const { setIsOpen } = useTypeaheadOpen();
  const searchRequestRef = useRef(0);
  const searchDebounceTimerRef = useRef<number | null>(null);
  const lastQueryRef = useRef<string | null>(null);
  const diffPaths = useMemo(() => new Set<string>(), []);
  const preferredRepoId = useUiPreferencesStore(
    (state) => state.fileSearchRepoId
  );
  const setFileSearchRepo = useUiPreferencesStore(
    (state) => state.setFileSearchRepo
  );
  const usePreferenceRepoSelection = isFileTrigger && repoIds === undefined;

  const effectiveRepoIds = useMemo(() => {
    if (!usePreferenceRepoSelection) {
      return repoIds;
    }
    return preferredRepoId ? [preferredRepoId] : undefined;
  }, [preferredRepoId, repoIds, usePreferenceRepoSelection]);

  const canSearchFiles = Boolean(effectiveRepoIds && effectiveRepoIds.length);
  const initialRepoId =
    isFileTrigger && effectiveRepoIds && effectiveRepoIds.length > 0
      ? effectiveRepoIds[0]
      : null;
  const { data: initialRepo } = useQuery<Repo | null>({
    queryKey: ['file-typeahead-repo', initialRepoId],
    queryFn: async () => {
      if (!initialRepoId) {
        return null;
      }

      return (await repoApi.getById(initialRepoId)) ?? null;
    },
    enabled: !!initialRepoId,
  });
  const { data: initialRootEntries, isLoading: isInitialRootEntriesLoading } =
    useQuery({
      queryKey: ['file-typeahead-root-entries', initialRepo?.path],
      queryFn: () => fileTreeApi.listDirectoryChildren(initialRepo!.path, ''),
      enabled: isFileTrigger && !!initialRepo?.path,
    });
  const initialFileOptions = useMemo(() => {
    if (!isFileTrigger || !initialRootEntries) {
      return [] as FileTagOption[];
    }

    const directoryOptions = initialRootEntries.directories.map((path) =>
      createInitialFileOption(path, 'directory')
    );
    const fileOptions = initialRootEntries.files.map((path) =>
      createInitialFileOption(path, 'file')
    );

    return [...directoryOptions, ...fileOptions].slice(0, MAX_FILE_RESULTS);
  }, [initialRootEntries, isFileTrigger]);

  const loadRecentRepos = useCallback(
    async (force = false): Promise<Repo[]> => {
      if (!force && recentRepoCatalog !== null) {
        return recentRepoCatalog;
      }
      const repos = await repoApi.listRecent();
      setRecentRepoCatalog(repos);
      return repos;
    },
    [recentRepoCatalog]
  );

  const runSearch = useCallback(
    async (query: string, overrideRepoIds?: string[]) => {
      const requestId = ++searchRequestRef.current;
      const normalizedQuery = query.trim();
      const scopedRepoIds = overrideRepoIds ?? effectiveRepoIds;
      const fileSearchEnabled = Boolean(
        scopedRepoIds && scopedRepoIds.length > 0
      );

      if (isFileTrigger && normalizedQuery === '') {
        setIsSearching(false);
        setOptions(initialFileOptions);
        return;
      }

      setIsSearching(true);

      const localFiles =
        isFileTrigger && fileSearchEnabled
          ? getMatchingDiffFiles(normalizedQuery, diffPaths)
          : [];
      const localFilePaths = new Set(localFiles.map((file) => file.path));

      try {
        const serverResults = await searchTagsAndFiles(normalizedQuery, {
          repoIds: scopedRepoIds,
          projectId,
          includeTags: isTagTrigger,
          includeFiles: isFileTrigger,
        });

        if (requestId !== searchRequestRef.current) {
          return;
        }

        if (isTagTrigger) {
          setOptions(serverResults.map((result) => new FileTagOption(result)));
          return;
        }

        const serverFileResults = serverResults
          .filter((result) => result.type === 'file')
          .filter((result) => !localFilePaths.has(result.file!.path));

        const limitedLocalFiles = localFiles.slice(0, MAX_FILE_RESULTS);
        const remainingSlots = MAX_FILE_RESULTS - limitedLocalFiles.length;
        const limitedServerFiles = serverFileResults.slice(0, remainingSlots);

        const mergedResults: SearchResultItem[] = [
          ...limitedLocalFiles.map((file) => ({
            type: 'file' as const,
            file,
          })),
          ...limitedServerFiles,
        ];

        setOptions(mergedResults.map((result) => new FileTagOption(result)));
      } catch (err) {
        if (requestId === searchRequestRef.current) {
          setOptions([]);
        }
        console.error('Failed to search tags/files', {
          err,
          query: normalizedQuery,
          requestId,
          trigger,
        });
      } finally {
        if (requestId === searchRequestRef.current) {
          setIsSearching(false);
        }
      }
    },
    [
      diffPaths,
      effectiveRepoIds,
      initialFileOptions,
      isFileTrigger,
      isTagTrigger,
      projectId,
      trigger,
    ]
  );

  const menuOptions = useMemo(() => {
    if (activeQuery === null) {
      return [] as FileTagOption[];
    }

    if (
      isFileTrigger &&
      activeQuery.trim() === '' &&
      initialRepoId &&
      (!initialRepo || isInitialRootEntriesLoading)
    ) {
      return [new FileTagOption(null, 'loading')];
    }

    if (isSearching) {
      return [new FileTagOption(null, 'loading')];
    }

    if (options.length === 0) {
      return [new FileTagOption(null, 'empty')];
    }

    return options;
  }, [
    activeQuery,
    isFileTrigger,
    initialRepo,
    initialRepoId,
    isInitialRootEntriesLoading,
    isSearching,
    options,
  ]);

  useEffect(() => {
    if (!isFileTrigger) {
      return;
    }
    if (activeQuery === null || activeQuery.trim() !== '') {
      return;
    }
    if (initialFileOptions.length === 0) {
      return;
    }
    setOptions(initialFileOptions);
  }, [activeQuery, initialFileOptions, isFileTrigger]);

  useEffect(() => {
    if (!usePreferenceRepoSelection || !preferredRepoId) {
      if (!preferredRepoId) {
        setPreferredRepoName(null);
      }
      return;
    }

    let canceled = false;
    void loadRecentRepos()
      .then(async (recentRepos) => {
        if (canceled) return;

        const matchingRecentRepo = recentRepos.find(
          (repo) => repo.id === preferredRepoId
        );
        if (matchingRecentRepo) {
          setPreferredRepoName(getRepoDisplayName(matchingRecentRepo));
          setShowMissingRepoState(false);
          return;
        }

        let existingRepo: Repo | null = null;
        try {
          existingRepo = await repoApi.getById(preferredRepoId);
        } catch {
          existingRepo = null;
        }

        if (canceled) return;
        if (existingRepo) {
          setPreferredRepoName(getRepoDisplayName(existingRepo));
          setShowMissingRepoState(false);
          return;
        }

        setPreferredRepoName(null);
        setShowMissingRepoState(true);
        setFileSearchRepo(null);

        const queryToRefresh = lastQueryRef.current;
        if (queryToRefresh !== null) {
          void runSearch(queryToRefresh, []);
        }
      })
      .catch((err) => {
        console.error('Failed to load repos for file-search preference', err);
      });

    return () => {
      canceled = true;
    };
  }, [
    loadRecentRepos,
    preferredRepoId,
    runSearch,
    setFileSearchRepo,
    usePreferenceRepoSelection,
  ]);

  const handleChooseRepo = useCallback(async () => {
    setIsChoosingRepo(true);
    try {
      const repos = await loadRecentRepos(true);
      const selectedRepo = repos[0];
      if (!selectedRepo) {
        setShowMissingRepoState(true);
        setFileSearchRepo(null);
        return;
      }

      setFileSearchRepo(selectedRepo.id);
      setPreferredRepoName(getRepoDisplayName(selectedRepo));
      setShowMissingRepoState(false);

      const queryToRefresh = lastQueryRef.current;
      if (queryToRefresh !== null) {
        void runSearch(queryToRefresh, [selectedRepo.id]);
      }
    } catch (err) {
      console.error('Failed to choose repo for file search', err);
    } finally {
      setIsChoosingRepo(false);
    }
  }, [loadRecentRepos, runSearch, setFileSearchRepo]);

  const onQueryChange = useCallback(
    (query: string | null) => {
      if (query === null) {
        setActiveQuery(null);
        setIsSearching(false);
        if (searchDebounceTimerRef.current !== null) {
          window.clearTimeout(searchDebounceTimerRef.current);
          searchDebounceTimerRef.current = null;
        }
        setOptions([]);
        return;
      }

      setActiveQuery(query);
      lastQueryRef.current = query;
      if (searchDebounceTimerRef.current !== null) {
        window.clearTimeout(searchDebounceTimerRef.current);
      }

      if (isFileTrigger && query.trim() === '') {
        setIsSearching(false);
        setOptions(initialFileOptions);
        return;
      }

      searchDebounceTimerRef.current = window.setTimeout(() => {
        searchDebounceTimerRef.current = null;
        void runSearch(query);
      }, 120);
    },
    [initialFileOptions, isFileTrigger, runSearch]
  );

  useEffect(() => {
    return () => {
      if (searchDebounceTimerRef.current !== null) {
        window.clearTimeout(searchDebounceTimerRef.current);
      }
    };
  }, []);

  return (
    <LexicalTypeaheadMenuPlugin<FileTagOption>
      triggerFn={
        trigger === '#' ? matchTagReferenceTrigger : matchFileReferenceTrigger
      }
      options={menuOptions}
      onQueryChange={onQueryChange}
      onOpen={() => {
        setIsOpen(true);
        onQueryChange('');
      }}
      onClose={() => {
        setIsOpen(false);
        setActiveQuery(null);
        setOptions([]);
      }}
      onSelectOption={(option, nodeToReplace, closeMenu) => {
        const selectedItem = option.item;
        if (!selectedItem) {
          return;
        }

        editor.update(() => {
          if (!nodeToReplace) return;

          if (selectedItem.type === 'tag') {
            const tag = selectedItem.tag!;
            const tagNode = $createTagReferenceNode({
              tagId: tag.id,
              tagName: tag.tag_name,
              content: tag.content,
            });
            nodeToReplace.replace(tagNode);

            const spaceNode = $createTextNode(' ');
            tagNode.insertAfter(spaceNode);
            spaceNode.select(1, 1);
            return;
          }

          const file = selectedItem.file!;
          const fileNode = $createFileReferenceNode({
            fileName: file.name,
            relativePath: file.path,
            kind: file.is_file ? 'file' : 'directory',
          });
          nodeToReplace.replace(fileNode);

          const spaceNode = $createTextNode(' ');
          fileNode.insertAfter(spaceNode);
          spaceNode.select(1, 1);
        });

        closeMenu();
      }}
      menuRenderFn={(
        anchorRef,
        { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }
      ) => {
        if (!anchorRef.current) return null;

        const resultOptions = menuOptions.filter(
          (option) => option.item !== null
        );
        const metaState =
          menuOptions.find((option) => option.meta)?.meta ?? null;
        const tagResults = isTagTrigger
          ? resultOptions.flatMap((option) =>
              option.item?.type === 'tag'
                ? [{ option, tag: option.item.tag! }]
                : []
            )
          : [];
        const fileResults = isFileTrigger
          ? resultOptions.flatMap((option) =>
              option.item?.type === 'file'
                ? [{ option, file: option.item.file! }]
                : []
            )
          : [];

        const canShowRepoSelector = isFileTrigger && usePreferenceRepoSelection;
        const showChooseRepoControl = canShowRepoSelector && !canSearchFiles;
        const showSelectedRepoState = canShowRepoSelector && canSearchFiles;
        const showFilesSection =
          isFileTrigger &&
          (fileResults.length > 0 ||
            showChooseRepoControl ||
            showSelectedRepoState ||
            showMissingRepoState);
        const hasSearchResults = isTagTrigger
          ? tagResults.length > 0
          : fileResults.length > 0;
        const showEmptyState =
          metaState === 'empty' && !hasSearchResults && !showFilesSection;
        const showLoadingState =
          metaState === 'loading' && !hasSearchResults && !showFilesSection;
        const selectedRepoLabel = preferredRepoName ?? preferredRepoId;
        const repoCtaLabel =
          showSelectedRepoState && selectedRepoLabel
            ? `Selected repo: ${selectedRepoLabel}`
            : 'Choose repository';

        return createPortal(
          <TypeaheadMenu anchorEl={anchorRef.current}>
            {showLoadingState ? (
              <TypeaheadMenu.Empty>
                {isTagTrigger ? 'Searching tags...' : 'Searching files...'}
              </TypeaheadMenu.Empty>
            ) : showEmptyState ? (
              <TypeaheadMenu.Empty>
                {isTagTrigger
                  ? 'No matching tags found.'
                  : 'No matching files found.'}
              </TypeaheadMenu.Empty>
            ) : (
              <TypeaheadMenu.ScrollArea>
                {isTagTrigger &&
                  tagResults.map(({ option, tag }, index) => (
                    <TypeaheadMenu.Item
                      key={option.key}
                      isSelected={index === selectedIndex}
                      index={index}
                      setHighlightedIndex={setHighlightedIndex}
                      setRefElement={option.setRefElement}
                      onClick={() => selectOptionAndCleanUp(option)}
                    >
                      <div className="font-medium">
                        <span>#{tag.tag_name}</span>
                      </div>
                      {tag.content && (
                        <div className="mt-0.5 truncate text-xs">
                          {tag.content.slice(0, 60)}
                          {tag.content.length > 60 ? '...' : ''}
                        </div>
                      )}
                    </TypeaheadMenu.Item>
                  ))}

                {isFileTrigger && (
                  <>
                    {showMissingRepoState && (
                      <TypeaheadMenu.Empty>
                        {'The selected repository is no longer available.'}
                      </TypeaheadMenu.Empty>
                    )}
                    {(showChooseRepoControl || showSelectedRepoState) && (
                      <TypeaheadMenu.Action
                        onClick={() => {
                          void handleChooseRepo();
                        }}
                        disabled={isChoosingRepo}
                      >
                        <span>
                          <span>{repoCtaLabel}</span>
                        </span>
                      </TypeaheadMenu.Action>
                    )}
                    {fileResults.map(({ option, file }, index) => (
                      <TypeaheadMenu.Item
                        key={option.key}
                        isSelected={index === selectedIndex}
                        index={index}
                        setHighlightedIndex={setHighlightedIndex}
                        setRefElement={option.setRefElement}
                        onClick={() => selectOptionAndCleanUp(option)}
                      >
                        <div className="truncate font-medium">
                          <span>{file.name}</span>
                        </div>
                        <div className="truncate text-xs">{file.path}</div>
                      </TypeaheadMenu.Item>
                    ))}
                  </>
                )}
              </TypeaheadMenu.ScrollArea>
            )}
          </TypeaheadMenu>,
          portalContainer ?? document.body
        );
      }}
    />
  );
}
