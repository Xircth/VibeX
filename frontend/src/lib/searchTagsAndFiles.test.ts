import { describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  listTags: vi.fn(),
  searchFiles: vi.fn(),
  searchProjectFiles: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  tagsApi: {
    list: apiMocks.listTags,
  },
  searchApi: {
    searchFiles: apiMocks.searchFiles,
  },
  projectsApi: {
    searchFiles: apiMocks.searchProjectFiles,
  },
}));

import { searchTagsAndFiles } from './searchTagsAndFiles';

describe('searchTagsAndFiles', () => {
  it('includes the built-in review changes tag preset', async () => {
    apiMocks.listTags.mockResolvedValue([]);

    const results = await searchTagsAndFiles('审查', {
      includeTags: true,
      includeFiles: false,
    });

    const reviewTag = results.find(
      (item) => item.type === 'tag' && item.tag?.id === 'builtin:review-changes'
    )?.tag;

    expect(reviewTag?.tag_name).toBe('审查变更');
    expect(reviewTag?.content).toContain('未提交代码变更');
  });
});
