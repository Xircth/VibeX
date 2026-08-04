import { describe, expect, it } from 'vitest';

import {
  buildTree,
  buildFileTreeDeleteConfirmation,
  buildFilePreviewSelectionSnippet,
  buildNewFileTreeItemRelativePath,
  deriveFileTreeContextMenuHeader,
  deriveFileTreeContextMenuPosition,
  deriveFileTreeEntries,
  deriveFileTreeGitStatusMap,
  deriveFileTreeKeyboardAction,
  deriveFileTreeNodeViewState,
  deriveFilePreviewAnchor,
  deriveFilePreviewDisplayState,
  deriveFilePreviewSelectionRange,
  deriveFolderGitStatusMap,
  expandFileTreeFoldersForSelection,
  ensureFileTreeParentFolderExpanded,
  getFileTreeExpansionPaths,
  getAreAllVisibleFileTreeFoldersExpanded,
  getFileTreeAbsoluteClipboardText,
  getFileTreeInlineNewInputConfig,
  getFileTreeMentionText,
  getFileTreeRelativeClipboardText,
  getFilePreviewImagePath,
  getFilePreviewInsertionText,
  getFilePreviewKind,
  getFilePreviewSelectionHints,
  normalizeDirectoryChildrenResponse,
  pruneExpandedFileTreeFolders,
  resolveFileTreeAbsolutePath,
  toggleAllFileTreeFolders,
  toggleFileTreeFolder,
} from './file-tree-utils';

describe('resolveFileTreeAbsolutePath', () => {
  it('joins POSIX workspace paths with relative paths', () => {
    expect(resolveFileTreeAbsolutePath('/repo/', 'src/index.ts')).toBe(
      '/repo/src/index.ts'
    );
  });

  it('joins Windows workspace paths and normalizes relative separators', () => {
    expect(resolveFileTreeAbsolutePath('C:\\repo\\', 'src/index.ts')).toBe(
      'C:\\repo\\src\\index.ts'
    );
  });

  it('returns existing absolute paths without workspace joining', () => {
    expect(resolveFileTreeAbsolutePath('C:\\repo', '/tmp/file.txt')).toBe(
      '/tmp/file.txt'
    );
    expect(resolveFileTreeAbsolutePath('C:\\repo', 'D:\\other\\file.txt')).toBe(
      'D:\\other\\file.txt'
    );
    expect(
      resolveFileTreeAbsolutePath('C:\\repo', '\\\\server\\share\\file.txt')
    ).toBe('\\\\server\\share\\file.txt');
  });

  it('strips Windows extended path prefixes before classifying paths', () => {
    expect(
      resolveFileTreeAbsolutePath('C:\\base', '\\\\?\\C:\\repo\\file.txt')
    ).toBe('C:\\repo\\file.txt');
    expect(
      resolveFileTreeAbsolutePath(
        'C:\\base',
        '\\\\?\\UNC\\server\\share\\file.txt'
      )
    ).toBe('\\\\server\\share\\file.txt');
  });
});

describe('normalizeDirectoryChildrenResponse', () => {
  it('passes through valid directory response arrays', () => {
    expect(
      normalizeDirectoryChildrenResponse({
        files: ['src/index.ts'],
        directories: ['src'],
        gitignored_files: ['dist/app.js'],
        gitignored_directories: ['target'],
        truncated: false,
      })
    ).toEqual({
      files: ['src/index.ts'],
      directories: ['src'],
      gitignoredFiles: ['dist/app.js'],
      gitignoredDirectories: ['target'],
    });
  });

  it('normalizes missing or malformed arrays to empty arrays', () => {
    expect(
      normalizeDirectoryChildrenResponse({
        files: null,
        directories: 'src',
        gitignored_files: undefined,
        gitignored_directories: { path: 'target' },
      } as never)
    ).toEqual({
      files: [],
      directories: [],
      gitignoredFiles: [],
      gitignoredDirectories: [],
    });
  });
});

describe('buildFilePreviewSelectionSnippet', () => {
  it('builds a single-line snippet with language fence', () => {
    expect(
      buildFilePreviewSelectionSnippet({
        path: 'src/index.ts',
        content: 'const value = 1;\nconsole.log(value);',
        selection: { start: 0, end: 0 },
      })
    ).toBe('src/index.ts:L1\n```typescript\nconst value = 1;\n```');
  });

  it('builds a multi-line snippet with a range label', () => {
    expect(
      buildFilePreviewSelectionSnippet({
        path: 'README.unknown',
        content: 'alpha\nbeta\ngamma',
        selection: { start: 1, end: 2 },
      })
    ).toBe('README.unknown:L2-L3\n```\nbeta\ngamma\n```');
  });
});

describe('getFilePreviewSelectionHints', () => {
  it('returns readable text preview selection hints only for text previews', () => {
    expect(getFilePreviewSelectionHints('text')).toEqual([
      'Shift+\u70b9\u51fb\u9009\u62e9\u8303\u56f4',
      '\u62d6\u62fd\u9009\u62e9\u591a\u884c',
    ]);
    expect(getFilePreviewSelectionHints('image')).toEqual([]);
  });
});

describe('file preview display state', () => {
  it('classifies text and image preview paths', () => {
    expect(getFilePreviewKind(null)).toBe('text');
    expect(getFilePreviewKind('src/App.tsx')).toBe('text');
    expect(getFilePreviewKind('assets/banner.PNG')).toBe('image');
  });

  it('uses text loading and error state for text previews', () => {
    expect(
      deriveFilePreviewDisplayState({
        previewKind: 'text',
        textLoading: true,
        textError: 'Cannot read file',
        imageLoading: false,
        imageError: new Error('image failed'),
      })
    ).toEqual({
      loading: true,
      error: 'Cannot read file',
    });
  });

  it('normalizes image loading and error state for image previews', () => {
    expect(
      deriveFilePreviewDisplayState({
        previewKind: 'image',
        textLoading: false,
        textError: 'text failed',
        imageLoading: true,
        imageError: new Error('image failed'),
      })
    ).toEqual({
      loading: true,
      error: 'image failed',
    });

    expect(
      deriveFilePreviewDisplayState({
        previewKind: 'image',
        textLoading: false,
        textError: 'text failed',
        imageLoading: false,
        imageError: 'raw failure',
      })
    ).toEqual({
      loading: false,
      error: 'raw failure',
    });

    expect(
      deriveFilePreviewDisplayState({
        previewKind: 'image',
        textLoading: false,
        textError: 'text failed',
        imageLoading: false,
        imageError: null,
      })
    ).toEqual({
      loading: false,
      error: null,
    });
  });
});

describe('getFilePreviewImagePath', () => {
  it('returns null without a preview path or for text previews', () => {
    expect(
      getFilePreviewImagePath({
        previewKind: 'image',
        previewPath: null,
        workspacePath: '/repo',
      })
    ).toBeNull();
    expect(
      getFilePreviewImagePath({
        previewKind: 'text',
        previewPath: 'src/index.ts',
        workspacePath: '/repo',
      })
    ).toBeNull();
  });

  it('resolves image preview paths against the workspace path', () => {
    expect(
      getFilePreviewImagePath({
        previewKind: 'image',
        previewPath: 'assets/logo.png',
        workspacePath: '/repo',
      })
    ).toBe('/repo/assets/logo.png');
    expect(
      getFilePreviewImagePath({
        previewKind: 'image',
        previewPath: '/tmp/logo.png',
        workspacePath: '/repo',
      })
    ).toBe('/tmp/logo.png');
  });
});

describe('deriveFilePreviewSelectionRange', () => {
  it('returns an ordered range regardless of anchor direction', () => {
    expect(deriveFilePreviewSelectionRange(2, 5)).toEqual({
      start: 2,
      end: 5,
    });
    expect(deriveFilePreviewSelectionRange(5, 2)).toEqual({
      start: 2,
      end: 5,
    });
  });

  it('supports single-line selections', () => {
    expect(deriveFilePreviewSelectionRange(4, 4)).toEqual({
      start: 4,
      end: 4,
    });
  });
});

describe('getFilePreviewInsertionText', () => {
  it('builds insertion text for text preview selections', () => {
    expect(
      getFilePreviewInsertionText({
        previewKind: 'text',
        path: 'src/index.ts',
        content: 'const value = 1;\nconsole.log(value);',
        selection: { start: 1, end: 1 },
      })
    ).toBe('src/index.ts:L2\n```typescript\nconsole.log(value);\n```');
  });

  it('returns null when preview selections cannot be inserted', () => {
    const base = {
      previewKind: 'text' as const,
      path: 'src/index.ts',
      content: 'line',
      selection: { start: 0, end: 0 },
    };

    expect(
      getFilePreviewInsertionText({ ...base, previewKind: 'image' })
    ).toBeNull();
    expect(getFilePreviewInsertionText({ ...base, path: null })).toBeNull();
    expect(
      getFilePreviewInsertionText({ ...base, selection: null })
    ).toBeNull();
  });
});

describe('deriveFilePreviewAnchor', () => {
  it('positions the preview to the left of the target inside the viewport', () => {
    expect(
      deriveFilePreviewAnchor({
        targetRect: { left: 900, top: 300, height: 24 },
        viewportWidth: 1200,
        viewportHeight: 900,
      })
    ).toEqual({
      top: 118,
      left: 244,
      arrowTop: 194,
      height: 520,
    });
  });

  it('clamps preview and arrow position in constrained viewports', () => {
    expect(
      deriveFilePreviewAnchor({
        targetRect: { left: 80, top: 20, height: 20 },
        viewportWidth: 500,
        viewportHeight: 300,
      })
    ).toEqual({
      top: 16,
      left: 16,
      arrowTop: 16,
      height: 268,
    });
  });
});

describe('deriveFileTreeContextMenuPosition', () => {
  it('uses the cursor position while the menu fits in the viewport', () => {
    expect(
      deriveFileTreeContextMenuPosition({
        x: 100,
        y: 80,
        viewportWidth: 1000,
        viewportHeight: 800,
      })
    ).toEqual({
      top: 80,
      left: 100,
    });
  });

  it('clamps the menu away from viewport edges', () => {
    expect(
      deriveFileTreeContextMenuPosition({
        x: 900,
        y: 760,
        viewportWidth: 1000,
        viewportHeight: 800,
      })
    ).toEqual({
      top: 540,
      left: 760,
    });

    expect(
      deriveFileTreeContextMenuPosition({
        x: 5,
        y: 5,
        viewportWidth: 200,
        viewportHeight: 200,
      })
    ).toEqual({
      top: 12,
      left: 12,
    });
  });
});

describe('deriveFileTreeContextMenuHeader', () => {
  it('uses the workspace root label for the root context menu', () => {
    expect(deriveFileTreeContextMenuHeader('', 'VibeX')).toEqual({
      title: 'VibeX',
      subtitle: null,
    });
  });

  it('uses the path leaf as title and full relative path as subtitle', () => {
    expect(
      deriveFileTreeContextMenuHeader('src/components/Button.tsx', 'VibeX')
    ).toEqual({
      title: 'Button.tsx',
      subtitle: 'src/components/Button.tsx',
    });

    expect(deriveFileTreeContextMenuHeader('/tmp/file.txt', 'VibeX')).toEqual({
      title: 'file.txt',
      subtitle: '/tmp/file.txt',
    });
  });
});

describe('deriveFileTreeKeyboardAction', () => {
  it('maps primary Delete and Backspace shortcuts to delete actions', () => {
    expect(
      deriveFileTreeKeyboardAction({
        selectedNodePath: 'src/index.ts',
        selectedNodeType: 'file',
        isMac: false,
        key: 'Delete',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
      })
    ).toEqual({ type: 'delete' });

    expect(
      deriveFileTreeKeyboardAction({
        selectedNodePath: 'src',
        selectedNodeType: 'folder',
        isMac: true,
        key: 'Backspace',
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
      })
    ).toEqual({ type: 'delete' });
  });

  it('maps unshifted primary C to absolute-path copy', () => {
    expect(
      deriveFileTreeKeyboardAction({
        selectedNodePath: 'src/index.ts',
        selectedNodeType: 'file',
        isMac: false,
        key: 'C',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
      })
    ).toEqual({ type: 'copyAbsolutePath' });
  });

  it('suppresses actions without selection, primary modifier, or eligible key', () => {
    const base = {
      selectedNodePath: 'src/index.ts',
      selectedNodeType: 'file' as const,
      isMac: false,
      key: 'c',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    };

    expect(
      deriveFileTreeKeyboardAction({ ...base, selectedNodePath: '' })
    ).toBeNull();
    expect(
      deriveFileTreeKeyboardAction({ ...base, selectedNodeType: null })
    ).toBeNull();
    expect(
      deriveFileTreeKeyboardAction({ ...base, ctrlKey: false })
    ).toBeNull();
    expect(
      deriveFileTreeKeyboardAction({ ...base, shiftKey: true })
    ).toBeNull();
    expect(deriveFileTreeKeyboardAction({ ...base, key: 'x' })).toBeNull();
  });
});

describe('deriveFileTreeNodeViewState', () => {
  it('derives lazy folder view state and row classes', () => {
    const result = deriveFileTreeNodeViewState({
      node: {
        name: 'src',
        path: 'src',
        type: 'folder',
        children: [],
        isLazyLoadable: true,
      },
      expandedFolders: new Set(['src']),
      loadingLazyDirectories: new Set(['src']),
      lazyDirectoryLoadErrors: new Map([['src', 'cannot load']]),
      folderGitStatusMap: new Map([['src', 'M']]),
      gitStatusMap: new Map(),
      mergedGitignoredDirectories: new Set(['src']),
      mergedGitignoredFiles: new Set(),
      selectedNodePath: 'src',
      dropTargetPath: 'src',
    });

    expect(result).toEqual({
      isFolder: true,
      isLazyFolder: true,
      hasChildren: false,
      canExpand: true,
      isExpanded: true,
      isLazyLoading: true,
      lazyLoadError: 'cannot load',
      fileGitStatus: 'M',
      gitStatusClass: ' git-m',
      isGitignored: true,
      isDropTarget: true,
      rowClassName:
        'file-tree-row is-folder is-gitignored is-selected is-drop-target',
    });
  });

  it('derives regular file view state and git status class', () => {
    const result = deriveFileTreeNodeViewState({
      node: {
        name: 'index.ts',
        path: 'src/index.ts',
        type: 'file',
        children: [],
      },
      expandedFolders: new Set(),
      loadingLazyDirectories: new Set(),
      lazyDirectoryLoadErrors: new Map(),
      folderGitStatusMap: new Map(),
      gitStatusMap: new Map([['src/index.ts', 'A']]),
      mergedGitignoredDirectories: new Set(),
      mergedGitignoredFiles: new Set(['src/index.ts']),
      selectedNodePath: null,
      dropTargetPath: null,
    });

    expect(result).toEqual({
      isFolder: false,
      isLazyFolder: false,
      hasChildren: false,
      canExpand: false,
      isExpanded: false,
      isLazyLoading: false,
      lazyLoadError: null,
      fileGitStatus: 'A',
      gitStatusClass: ' git-a',
      isGitignored: true,
      isDropTarget: false,
      rowClassName: 'file-tree-row is-file is-gitignored',
    });
  });
});

describe('getFileTreeMentionText', () => {
  it('appends a trailing space for file mentions only', () => {
    expect(getFileTreeMentionText('src/index.ts', 'file')).toBe(
      'src/index.ts '
    );
    expect(getFileTreeMentionText('src/components', 'folder')).toBe(
      'src/components'
    );
  });
});

describe('file tree folder expansion policy', () => {
  it('prunes expanded folders that no longer exist', () => {
    expect(
      Array.from(
        pruneExpandedFileTreeFolders(
          new Set(['src', 'src/old', 'docs']),
          new Set(['src', 'docs'])
        )
      )
    ).toEqual(['src', 'docs']);
  });

  it('detects whether all visible folders are expanded', () => {
    expect(
      getAreAllVisibleFileTreeFoldersExpanded(
        new Set(['src', 'docs']),
        new Set(['src', 'docs', 'hidden'])
      )
    ).toBe(true);
    expect(
      getAreAllVisibleFileTreeFoldersExpanded(
        new Set(['src', 'docs']),
        new Set(['src'])
      )
    ).toBe(false);
    expect(
      getAreAllVisibleFileTreeFoldersExpanded(new Set(), new Set(['src']))
    ).toBe(false);
  });

  it('expands or collapses all visible folders while preserving hidden entries', () => {
    expect(
      Array.from(
        toggleAllFileTreeFolders({
          expandedFolders: new Set(['hidden']),
          visibleFolderPaths: new Set(['src', 'docs']),
          allVisibleExpanded: false,
        })
      )
    ).toEqual(['hidden', 'src', 'docs']);

    expect(
      Array.from(
        toggleAllFileTreeFolders({
          expandedFolders: new Set(['hidden', 'src', 'docs']),
          visibleFolderPaths: new Set(['src', 'docs']),
          allVisibleExpanded: true,
        })
      )
    ).toEqual(['hidden']);
  });

  it('toggles one folder path', () => {
    expect(Array.from(toggleFileTreeFolder(new Set(['src']), 'docs'))).toEqual([
      'src',
      'docs',
    ]);
    expect(Array.from(toggleFileTreeFolder(new Set(['src']), 'src'))).toEqual(
      []
    );
  });
});

describe('ensureFileTreeParentFolderExpanded', () => {
  it('keeps the same set for root or already expanded parents', () => {
    const expanded = new Set(['src']);

    expect(ensureFileTreeParentFolderExpanded(expanded, '')).toBe(expanded);
    expect(ensureFileTreeParentFolderExpanded(expanded, 'src')).toBe(expanded);
  });

  it('adds collapsed parents without mutating the original set', () => {
    const expanded = new Set(['src']);
    const result = ensureFileTreeParentFolderExpanded(expanded, 'docs');

    expect(Array.from(result)).toEqual(['src', 'docs']);
    expect(Array.from(expanded)).toEqual(['src']);
  });
});

describe('file tree reveal expansion', () => {
  it('derives every ancestor folder that must expand for a file selection', () => {
    expect(getFileTreeExpansionPaths('frontend/src/App.tsx', 'file')).toEqual([
      'frontend',
      'frontend/src',
    ]);
  });

  it('includes the target folder when revealing a directory selection', () => {
    expect(
      getFileTreeExpansionPaths('frontend/src/components', 'folder')
    ).toEqual(['frontend', 'frontend/src', 'frontend/src/components']);
  });

  it('adds missing reveal folders without mutating the original set', () => {
    const expanded = new Set(['frontend']);
    const result = expandFileTreeFoldersForSelection(
      expanded,
      'frontend/src/components',
      'folder'
    );

    expect(Array.from(result)).toEqual([
      'frontend',
      'frontend/src',
      'frontend/src/components',
    ]);
    expect(Array.from(expanded)).toEqual(['frontend']);
  });
});

describe('getFileTreeInlineNewInputConfig', () => {
  it('returns file inline input defaults', () => {
    expect(getFileTreeInlineNewInputConfig('file')).toEqual({
      fallbackName: 'untitled',
      iconPath: 'untitled',
      isFolder: false,
    });
  });

  it('returns folder inline input defaults', () => {
    expect(getFileTreeInlineNewInputConfig('folder')).toEqual({
      fallbackName: '新建文件夹',
      iconPath: 'folder',
      isFolder: true,
    });
  });
});

describe('buildNewFileTreeItemRelativePath', () => {
  it('builds root-level and nested item paths', () => {
    expect(buildNewFileTreeItemRelativePath('', 'index.ts', 'untitled')).toBe(
      'index.ts'
    );
    expect(
      buildNewFileTreeItemRelativePath(
        'src/components',
        'Button.tsx',
        'untitled'
      )
    ).toBe('src/components/Button.tsx');
  });

  it('trims names and falls back when the input is blank', () => {
    expect(
      buildNewFileTreeItemRelativePath('src', '  config.ts  ', 'untitled')
    ).toBe('src/config.ts');
    expect(buildNewFileTreeItemRelativePath('', '   ', 'untitled')).toBe(
      'untitled'
    );
    expect(buildNewFileTreeItemRelativePath('src', '', '新建文件夹')).toBe(
      'src/新建文件夹'
    );
  });
});

describe('buildFileTreeDeleteConfirmation', () => {
  it('builds confirmation copy for files and folders', () => {
    expect(buildFileTreeDeleteConfirmation('src/index.ts', false)).toEqual({
      title: '删除',
      message: '确定要删除文件“index.ts”吗？',
      confirmText: '删除',
      cancelText: '取消',
      variant: 'destructive',
    });

    expect(buildFileTreeDeleteConfirmation('src/components', true)).toEqual({
      title: '删除',
      message: '确定要删除文件夹“components”吗？',
      confirmText: '删除',
      cancelText: '取消',
      variant: 'destructive',
    });
  });
});

describe('file tree clipboard path text', () => {
  it('uses dot for root relative path copies', () => {
    expect(getFileTreeRelativeClipboardText('')).toBe('.');
    expect(getFileTreeRelativeClipboardText('src/index.ts')).toBe(
      'src/index.ts'
    );
  });

  it('uses the workspace path for root absolute path copies', () => {
    expect(
      getFileTreeAbsoluteClipboardText('', '/repo/index.ts', '/repo')
    ).toBe('/repo');
    expect(
      getFileTreeAbsoluteClipboardText(
        'src/index.ts',
        '/repo/src/index.ts',
        '/repo'
      )
    ).toBe('/repo/src/index.ts');
  });
});

describe('deriveFileTreeEntries', () => {
  it('merges base and lazy entries without duplicates', () => {
    const result = deriveFileTreeEntries({
      files: ['src/index.ts'],
      directories: ['src'],
      ignoredFiles: new Set(['dist/app.js']),
      ignoredDirectories: new Set(['target']),
      lazyFiles: new Set(['src/index.ts', 'src/lazy.ts']),
      lazyDirectories: new Set(['src/generated']),
      lazyGitignoredFiles: new Set(['coverage/out.js']),
      lazyGitignoredDirectories: new Set(['node_modules']),
      lazyLoadableDirectories: new Set(['src/generated']),
      lazyLoadAllDirectories: false,
    });

    expect(result.mergedFiles).toEqual(['src/index.ts', 'src/lazy.ts']);
    expect(result.mergedDirectories).toEqual(['src', 'src/generated']);
    expect(Array.from(result.mergedGitignoredFiles)).toEqual([
      'dist/app.js',
      'coverage/out.js',
    ]);
    expect(Array.from(result.mergedGitignoredDirectories)).toEqual([
      'target',
      'node_modules',
    ]);
    expect(Array.from(result.effectiveLazyLoadableDirectories)).toEqual([
      'src/generated',
    ]);
  });

  it('marks all directories or special directories as lazy-loadable', () => {
    const allLazy = deriveFileTreeEntries({
      files: [],
      directories: ['src', 'node_modules'],
      ignoredFiles: new Set(),
      ignoredDirectories: new Set(),
      lazyFiles: new Set(),
      lazyDirectories: new Set(['dist']),
      lazyGitignoredFiles: new Set(),
      lazyGitignoredDirectories: new Set(),
      lazyLoadableDirectories: new Set(),
      lazyLoadAllDirectories: true,
    });

    expect(Array.from(allLazy.effectiveLazyLoadableDirectories)).toEqual([
      'src',
      'node_modules',
      'dist',
    ]);

    const specialOnly = deriveFileTreeEntries({
      files: [],
      directories: ['src', 'node_modules'],
      ignoredFiles: new Set(),
      ignoredDirectories: new Set(),
      lazyFiles: new Set(),
      lazyDirectories: new Set(),
      lazyGitignoredFiles: new Set(),
      lazyGitignoredDirectories: new Set(),
      lazyLoadableDirectories: new Set(),
      lazyLoadAllDirectories: false,
    });

    expect(Array.from(specialOnly.effectiveLazyLoadableDirectories)).toEqual([
      'node_modules',
    ]);
  });
});

describe('deriveFileTreeGitStatusMap', () => {
  it('returns an empty map when status entries are missing', () => {
    expect(Array.from(deriveFileTreeGitStatusMap(undefined))).toEqual([]);
  });

  it('preserves last-write-wins status mapping for duplicate paths', () => {
    expect(
      Array.from(
        deriveFileTreeGitStatusMap([
          { path: 'src/index.ts', status: 'modified' },
          { path: 'src/app.ts', status: 'added' },
          { path: 'src/index.ts', status: 'deleted' },
        ])
      )
    ).toEqual([
      ['src/index.ts', 'deleted'],
      ['src/app.ts', 'added'],
    ]);
  });
});

describe('deriveFolderGitStatusMap', () => {
  it('assigns folders the highest-priority descendant git status', () => {
    const { nodes } = deriveTestTree({
      files: [
        'src/modified.ts',
        'src/deleted.ts',
        'src/nested/renamed.ts',
        'docs/touched.md',
      ],
      directories: ['src', 'src/nested', 'docs', 'empty'],
    });
    const statuses = new Map([
      ['src/modified.ts', 'M'],
      ['src/deleted.ts', 'D'],
      ['src/nested/renamed.ts', 'R'],
      ['docs/touched.md', 'T'],
    ]);

    const result = deriveFolderGitStatusMap(nodes, statuses);

    expect(result.get('src')).toBe('D');
    expect(result.get('src/nested')).toBe('R');
    expect(result.get('docs')).toBe('T');
    expect(result.has('empty')).toBe(false);
  });
});

function deriveTestTree({
  files,
  directories,
}: {
  files: string[];
  directories: string[];
}) {
  return buildTree(files, directories, new Set());
}
