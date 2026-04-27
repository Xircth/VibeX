import { projectsApi, searchApi, tagsApi } from '@/lib/api';
import type { SearchResult, Tag } from 'shared/types';

interface FileSearchResult extends SearchResult {
  name: string;
}

export interface SearchResultItem {
  type: 'tag' | 'file';
  tag?: Tag;
  file?: FileSearchResult;
}

export interface SearchOptions {
  repoIds?: string[];
  projectId?: string;
  includeTags?: boolean;
  includeFiles?: boolean;
}

const TAG_CACHE_TTL_MS = 30_000;
const BUILTIN_DEV_SERVER_TAG: Tag = {
  id: 'builtin:start-project-dev-server',
  tag_name: '启动项目开发服务器',
  content:
    '分析当前项目并识别正确的开发服务器启动方式；必要时检查或安装依赖并修复基础环境问题；成功启动后验证服务可访问，再把可访问的本地 URL 直接告诉我。',
  created_at: '',
  updated_at: '',
};

let cachedTags: Tag[] | null = null;
let cachedTagsAt = 0;
let pendingTagsRequest: Promise<Tag[]> | null = null;

async function loadCachedTags(): Promise<Tag[]> {
  const now = Date.now();
  if (cachedTags && now - cachedTagsAt < TAG_CACHE_TTL_MS) {
    return cachedTags;
  }

  if (pendingTagsRequest) {
    return pendingTagsRequest;
  }

  pendingTagsRequest = tagsApi
    .list()
    .then((tags) => {
      const mergedTags = new Map<string, Tag>();
      mergedTags.set(
        BUILTIN_DEV_SERVER_TAG.tag_name.toLowerCase(),
        BUILTIN_DEV_SERVER_TAG
      );
      for (const tag of tags) {
        mergedTags.set(tag.tag_name.toLowerCase(), tag);
      }

      cachedTags = Array.from(mergedTags.values()).sort((left, right) =>
        left.tag_name.localeCompare(right.tag_name, 'zh-CN')
      );
      cachedTagsAt = Date.now();
      return cachedTags;
    })
    .finally(() => {
      pendingTagsRequest = null;
    });

  return pendingTagsRequest;
}

export async function searchTagsAndFiles(
  query: string,
  options?: SearchOptions
): Promise<SearchResultItem[]> {
  const results: SearchResultItem[] = [];
  const includeTags = options?.includeTags ?? true;
  const includeFiles = options?.includeFiles ?? true;

  // Tags are global and rarely change. Cache them to avoid hammering the
  // SQLite pool on every keystroke in the typeahead menu.
  if (includeTags) {
    const tags = await loadCachedTags();
    const filteredTags = tags.filter((tag) =>
      tag.tag_name.toLowerCase().includes(query.toLowerCase())
    );
    results.push(...filteredTags.map((tag) => ({ type: 'tag' as const, tag })));
  }

  // Fetch files - prefer repo-scoped if available
  if (includeFiles && query.length > 0) {
    let fileResults: SearchResult[] = [];
    if (options?.repoIds && options.repoIds.length > 0) {
      fileResults = await searchApi.searchFiles(options.repoIds, query);
    } else if (options?.projectId) {
      fileResults = await projectsApi.searchFiles(options.projectId, query);
    }

    if (fileResults.length > 0) {
      const fileSearchResults: FileSearchResult[] = fileResults.map((item) => ({
        ...item,
        name: item.path.split('/').pop() || item.path,
      }));
      results.push(
        ...fileSearchResults.map((file) => ({ type: 'file' as const, file }))
      );
    }
  }

  return results;
}
