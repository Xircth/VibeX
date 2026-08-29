import { ChevronDown, ChevronRight, FileCode2, Folder } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { PluginContentDocument } from '@/lib/api/plugins';
import { officialPluginReadme } from './officialPlugins';

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

const KIND_ORDER = [
  'mcp',
  'runtime',
  'skill',
  'viewer',
  'hook',
  'workflow',
  'other',
] as const;

function kindGroup(kind: string) {
  if (kind === 'skill') return 'skill';
  if (kind === 'mcp') return 'mcp';
  if (kind === 'hook') return 'hook';
  if (kind === 'workflow') return 'workflow';
  if (kind === 'runtime') return 'runtime';
  if (
    kind === 'file_opener' ||
    kind === 'preview_provider' ||
    kind === 'app_surface' ||
    kind === 'viewer'
  ) {
    return 'viewer';
  }
  return 'other';
}

function kindRank(name: string) {
  const index = KIND_ORDER.indexOf(name as (typeof KIND_ORDER)[number]);
  return index === -1 ? KIND_ORDER.length : index;
}

function buildContentTree(documents: PluginContentDocument[]) {
  const root: MutablePluginContentTree = {
    name: '',
    path: '',
    folders: new Map(),
    documents: [],
  };

  for (const document of documents) {
    const group = kindGroup(document.kind);
    const segments = document.path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) continue;
    const nested = segments.filter(
      (segment) =>
        segment !== 'contents' && segment !== group && segment !== `${group}s`
    );
    let current = root;
    if (group) {
      let folder = current.folders.get(group);
      if (!folder) {
        folder = {
          name: group,
          path: group,
          folders: new Map(),
          documents: [],
        };
        current.folders.set(group, folder);
      }
      current = folder;
    }
    for (const segment of nested) {
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
      .sort((left, right) => {
        const rank = kindRank(left.name) - kindRank(right.name);
        return rank !== 0 ? rank : left.name.localeCompare(right.name);
      })
      .map(finalize),
    documents: [...node.documents].sort((left, right) =>
      left.fileName.localeCompare(right.fileName)
    ),
  });

  return finalize(root);
}

export function groupedPluginContents(documents: PluginContentDocument[]) {
  const groups = new Map<string, PluginContentDocument[]>();
  for (const document of documents) {
    const group = kindGroup(document.kind);
    const items = groups.get(group) ?? [];
    items.push(document);
    groups.set(group, items);
  }
  return KIND_ORDER.filter((kind) => groups.has(kind)).map((kind) => ({
    kind,
    items: groups.get(kind) ?? [],
  }));
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
  const { t } = useTranslation('settings');
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
              <span>
                {t(`plugins.contentKind.${folder.name}`, {
                  defaultValue: folder.name,
                })}
              </span>
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

export function PluginReadmeView({
  pluginId,
  readme,
}: {
  pluginId: string;
  readme: string;
}) {
  const { t } = useTranslation('settings');
  const value = officialPluginReadme(pluginId, readme, t);
  return (
    <article
      className="product-plugin-readme"
      aria-label={t('plugins.readmeTab')}
    >
      {value.trim() ? (
        <AstryxMarkdown value={value} />
      ) : (
        <p className="product-plugin-muted">{t('plugins.noSummary')}</p>
      )}
    </article>
  );
}

export function PluginContentsView({
  contents,
}: {
  contents: PluginContentDocument[];
}) {
  const { t } = useTranslation('settings');
  const groups = useMemo(() => groupedPluginContents(contents), [contents]);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(groups.map((group) => group.kind))
  );

  useEffect(() => {
    setExpanded(new Set(groups.map((group) => group.kind)));
  }, [groups]);

  if (groups.length === 0) {
    return (
      <p className="product-plugin-muted">{t('plugins.contentsEmpty')}</p>
    );
  }

  const toggleGroup = (kind: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  return (
    <div
      className="product-plugin-contents"
      role="region"
      aria-label={t('plugins.contentsCatalog')}
    >
      {groups.map((group) => {
        const open = expanded.has(group.kind);
        const label = t(`plugins.contentKind.${group.kind}`, {
          defaultValue: group.kind,
        });
        const listId = `plugin-contents-${group.kind}`;
        return (
          <section key={group.kind} className="product-plugin-contents-group">
            <button
              type="button"
              className="product-plugin-contents-toggle"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => toggleGroup(group.kind)}
            >
              {open ? (
                <ChevronDown aria-hidden="true" />
              ) : (
                <ChevronRight aria-hidden="true" />
              )}
              <h2>{label}</h2>
              <span>{group.items.length}</span>
            </button>
            {open ? (
              <ul id={listId}>
                {group.items.map((item) => (
                  <li key={item.path}>
                    {item.title ||
                      item.path.split('/').filter(Boolean).at(-1)}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export function PluginPackageTree({
  contents,
}: {
  contents: PluginContentDocument[];
}) {
  const { t } = useTranslation('settings');
  const tree = useMemo(() => buildContentTree(contents), [contents]);
  const allFolderPaths = useMemo(() => collectFolderPaths(tree), [tree]);
  const [selectedPath, setSelectedPath] = useState(
    () => tree.documents[0]?.document.path ?? tree.folders[0]?.path ?? ''
  );
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(allFolderPaths)
  );

  useEffect(() => {
    setExpanded(new Set(allFolderPaths));
  }, [allFolderPaths]);

  const selected = contents.find((document) => document.path === selectedPath);
  const documentTitle = selected?.path.split('/').at(-1) ?? '';
  const isMarkdown = selected?.path.endsWith('.md') ?? false;

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
        {selected ? (
          <article className="product-plugin-document">
            <header>
              <strong>{documentTitle}</strong>
            </header>
            {isMarkdown ? (
              <AstryxMarkdown value={selected.content} />
            ) : (
              <pre>{selected.content}</pre>
            )}
          </article>
        ) : (
          <p className="product-plugin-muted">{t('plugins.contentsEmpty')}</p>
        )}
      </ScrollArea>
    </section>
  );
}
