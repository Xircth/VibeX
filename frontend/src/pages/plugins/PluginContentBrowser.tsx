import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
} from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { ScrollArea } from '@/components/ui/scroll-area';
import type {
  PluginContentDocument,
  PluginProductDetail,
} from '@/lib/api/plugins';

interface PluginContentTree {
  name: string;
  path: string;
  folders: PluginContentTree[];
  documents: Array<{
    document: PluginContentDocument;
    fileName: string;
  }>;
}

interface MutablePluginContentTree {
  name: string;
  path: string;
  folders: Map<string, MutablePluginContentTree>;
  documents: PluginContentTree['documents'];
}

function buildContentTree(documents: PluginContentDocument[]) {
  const root: MutablePluginContentTree = {
    name: '',
    path: '',
    folders: new Map(),
    documents: [],
  };

  for (const document of documents) {
    const segments = document.path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) continue;
    let current = root;
    for (const segment of segments) {
      const path = current.path ? `${current.path}/${segment}` : segment;
      let folder = current.folders.get(segment);
      if (!folder) {
        folder = {
          name: segment,
          path,
          folders: new Map(),
          documents: [],
        };
        current.folders.set(segment, folder);
      }
      current = folder;
    }
    current.documents.push({ document, fileName });
  }

  const finalize = (node: MutablePluginContentTree): PluginContentTree => ({
    name: node.name,
    path: node.path,
    folders: [...node.folders.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(finalize),
    documents: [...node.documents].sort((left, right) =>
      left.fileName.localeCompare(right.fileName)
    ),
  });

  return finalize(root);
}

function collectFolderPaths(tree: PluginContentTree): string[] {
  return tree.folders.flatMap((folder) => [
    folder.path,
    ...collectFolderPaths(folder),
  ]);
}

function ContentTree({
  tree,
  depth = 0,
  expanded,
  selectedPath,
  onToggle,
  onSelect,
}: {
  tree: PluginContentTree;
  depth?: number;
  expanded: Set<string>;
  selectedPath: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {tree.folders.map((folder) => {
        const isExpanded = expanded.has(folder.path);
        return (
          <div className="product-plugin-tree-folder" key={folder.path}>
            <button
              type="button"
              className="product-plugin-tree-label"
              style={{ '--tree-depth': depth } as CSSProperties}
              title={folder.path}
              aria-expanded={isExpanded}
              onClick={() => onToggle(folder.path)}
            >
              {isExpanded ? (
                <ChevronDown
                  aria-hidden="true"
                  className="product-plugin-tree-disclosure"
                />
              ) : (
                <ChevronRight
                  aria-hidden="true"
                  className="product-plugin-tree-disclosure"
                />
              )}
              <Folder aria-hidden="true" />
              <span>{folder.name}</span>
            </button>
            {isExpanded ? (
              <ContentTree
                tree={folder}
                depth={depth + 1}
                expanded={expanded}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ) : null}
          </div>
        );
      })}
      {tree.documents.map(({ document, fileName }) => (
        <button
          key={document.path}
          type="button"
          className={selectedPath === document.path ? 'is-active' : undefined}
          style={{ '--tree-depth': depth } as CSSProperties}
          onClick={() => onSelect(document.path)}
          title={document.path}
          aria-label={fileName}
        >
          <FileCode2 aria-hidden="true" />
          <span>{fileName}</span>
        </button>
      ))}
    </>
  );
}

export function PluginContentBrowser({
  detail,
}: {
  detail: PluginProductDetail;
}) {
  const { t } = useTranslation('settings');
  const [selectedPath, setSelectedPath] = useState('README.md');
  const tree = useMemo(() => buildContentTree(detail.contents), [detail]);
  const allFolderPaths = useMemo(() => collectFolderPaths(tree), [tree]);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(allFolderPaths)
  );

  useEffect(() => {
    setSelectedPath('README.md');
    setExpanded(new Set(allFolderPaths));
  }, [allFolderPaths, detail]);

  const selected = detail.contents.find(
    (document) => document.path === selectedPath
  );
  const documentTitle = selected?.path.split('/').at(-1) ?? 'README.md';
  const documentContent = selected?.content ?? detail.readme;
  const isMarkdown = !selected || selected.path.endsWith('.md');

  const toggleFolder = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <section className="product-plugin-content-browser">
      <ScrollArea
        className="product-plugin-tree-scroll"
        role="region"
        aria-label={t('plugins.contentTree')}
      >
        <nav aria-label={t('plugins.contentTree')}>
          <button
            type="button"
            className={selectedPath === 'README.md' ? 'is-active' : undefined}
            onClick={() => setSelectedPath('README.md')}
          >
            <FileText aria-hidden="true" />
            <span>README.md</span>
          </button>
          <div className="product-plugin-tree-root">
            <ContentTree
              tree={tree}
              expanded={expanded}
              selectedPath={selectedPath}
              onToggle={toggleFolder}
              onSelect={setSelectedPath}
            />
          </div>
        </nav>
      </ScrollArea>
      <ScrollArea
        className="product-plugin-document-scroll"
        role="region"
        aria-label={t('plugins.contentPreview')}
      >
        <article className="product-plugin-document">
          <header>
            <strong>{documentTitle}</strong>
            <code>{selected?.path ?? 'README.md'}</code>
          </header>
          {isMarkdown ? (
            <AstryxMarkdown value={documentContent} />
          ) : (
            <pre>{documentContent}</pre>
          )}
        </article>
      </ScrollArea>
    </section>
  );
}
