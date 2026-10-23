import {
  Table,
  pixel,
  proportional,
  useTableTreeData,
  useTableTreeState,
  type TableColumn,
} from '@astryxdesign/core/Table';
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Cpu,
  Eye,
  FileCode2,
  Folder,
  GitBranch,
  Sparkles,
  Webhook,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import '@/components/previews/markdownFileProse.css';
import type {
  CatalogListing,
  PluginContentDocument,
  PluginContributionCatalogItem,
  PluginControlItem,
} from '@/lib/api/plugins';
import { resolvePluginTelemetry } from './PluginAttributeBadges';
import {
  buildRepoTreeNodes,
  entriesFromContents,
  groupedPluginContents,
  resolvePluginComponentDocuments,
  type PackageTreeNode,
  type RepoTreeEntry,
} from './officialPluginContentCatalog';
import { officialPluginReadme } from './officialPlugins';

export {
  groupedPluginContents,
  resolvePluginComponentDocuments,
  type PackageTreeNode,
};

const githubRepoTreeCache = new Map<string, RepoTreeEntry[]>();

function renderComponentGroupIcon(kind: string) {
  switch (kind) {
    case 'ui':
    case 'viewer':
      return <Eye aria-hidden="true" className="dsh-component-group-icon" />;
    case 'mcp':
      return <Wrench aria-hidden="true" className="dsh-component-group-icon" />;
    case 'runtime':
      return <Cpu aria-hidden="true" className="dsh-component-group-icon" />;
    case 'skill':
      return (
        <Sparkles aria-hidden="true" className="dsh-component-group-icon" />
      );
    case 'workflow':
      return (
        <GitBranch aria-hidden="true" className="dsh-component-group-icon" />
      );
    case 'hook':
      return (
        <Webhook aria-hidden="true" className="dsh-component-group-icon" />
      );
    default:
      return <Boxes aria-hidden="true" className="dsh-component-group-icon" />;
  }
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
      className="product-plugin-readme dsh-plugin-readme-card"
      aria-label={t('plugins.readmeTab')}
    >
      {value.trim() ? (
        <AstryxMarkdown
          value={value}
          className="markdown-file-prose dsh-standard-markdown"
        />
      ) : (
        <p className="product-plugin-muted">{t('plugins.noSummary')}</p>
      )}
    </article>
  );
}

export function PluginContentsView({
  contents,
  pluginId,
  owner,
  plugin,
  contributions,
  listing,
  preferOfficialCatalog,
}: {
  contents: PluginContentDocument[];
  pluginId?: string;
  owner?: string | null;
  plugin?: PluginControlItem | null;
  contributions?: PluginContributionCatalogItem[] | null;
  listing?: CatalogListing | null;
  preferOfficialCatalog?: boolean;
}) {
  const { t, i18n } = useTranslation('settings');
  const isZh = i18n.language.toLowerCase().startsWith('zh');
  const resolvedContents = useMemo(
    () =>
      resolvePluginComponentDocuments({
        contents,
        pluginId,
        owner,
        plugin,
        contributions,
        listing,
        preferOfficialCatalog,
      }),
    [
      contents,
      contributions,
      listing,
      owner,
      plugin,
      pluginId,
      preferOfficialCatalog,
    ]
  );
  const groups = useMemo(
    () => groupedPluginContents(resolvedContents),
    [resolvedContents]
  );
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(groups.map((group) => group.kind))
  );

  useEffect(() => {
    setExpanded(new Set(groups.map((group) => group.kind)));
  }, [groups]);

  if (groups.length === 0) {
    return <p className="product-plugin-muted">{t('plugins.contentsEmpty')}</p>;
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
      className="product-plugin-contents dsh-components-catalog"
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
          <section
            key={group.kind}
            className="product-plugin-contents-group dsh-component-group"
          >
            <button
              type="button"
              className="product-plugin-contents-toggle dsh-component-group-toggle"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => toggleGroup(group.kind)}
            >
              {open ? (
                <ChevronDown aria-hidden="true" />
              ) : (
                <ChevronRight aria-hidden="true" />
              )}
              {renderComponentGroupIcon(group.kind)}
              <h2>{label}</h2>
              <span className="dsh-component-count-pill">
                {group.items.length}
              </span>
            </button>
            {open ? (
              <ul id={listId} className="dsh-component-list">
                {group.items.map((item) => {
                  const titleText =
                    item.title ||
                    item.path.split('/').filter(Boolean).at(-1) ||
                    item.path;
                  return (
                    <li key={item.path} className="dsh-component-row">
                      <div className="dsh-component-row-main">
                        <span
                          className="dsh-component-row-icon"
                          aria-hidden="true"
                        >
                          <FileCode2 aria-hidden="true" />
                        </span>
                        <div className="dsh-component-row-copy">
                          <span className="dsh-component-row-title">
                            {titleText}
                          </span>
                          <code className="dsh-component-row-path">
                            {item.path}
                          </code>
                        </div>
                      </div>
                      <div className="dsh-component-row-meta">
                        <span className="dsh-component-kind-tag">
                          {item.kind}
                        </span>
                        <span className="dsh-state-badge">
                          <span
                            className="dsh-state-dot"
                            data-state="done"
                            aria-hidden="true"
                          />
                          <span>{isZh ? '已就绪' : 'Ready'}</span>
                        </span>
                      </div>
                    </li>
                  );
                })}
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
  pluginId,
  owner,
  homepage,
  repo,
  sourceOrigin,
}: {
  contents: PluginContentDocument[];
  pluginId?: string;
  owner?: string | null;
  homepage?: string | null;
  repo?: string | null;
  sourceOrigin?: string | null;
}) {
  const { t, i18n } = useTranslation('settings');
  const isZh = i18n.language.toLowerCase().startsWith('zh');
  const telemetry = useMemo(
    () =>
      resolvePluginTelemetry({
        pluginId: pluginId ?? '',
        owner,
        homepage,
        repo,
        sourceOrigin,
      }),
    [homepage, owner, pluginId, repo, sourceOrigin]
  );
  const repositorySlug = telemetry.repositorySlug;
  const [repoEntries, setRepoEntries] = useState<RepoTreeEntry[] | null>(
    () => githubRepoTreeCache.get(repositorySlug) ?? null
  );

  useEffect(() => {
    const cached = githubRepoTreeCache.get(repositorySlug);
    if (cached) {
      setRepoEntries(cached);
      return;
    }
    if (
      !repositorySlug ||
      !repositorySlug.includes('/') ||
      typeof fetch !== 'function'
    ) {
      return;
    }
    const controller = new AbortController();
    fetch(
      `https://api.github.com/repos/${repositorySlug}/git/trees/HEAD?recursive=1`,
      {
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json' },
      }
    )
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: {
            tree?: Array<{
              path?: unknown;
              type?: unknown;
              size?: unknown;
            }>;
          } | null
        ) => {
          if (!data || !Array.isArray(data.tree)) return;
          const parsed: RepoTreeEntry[] = data.tree
            .filter(
              (item) =>
                typeof item.path === 'string' &&
                (item.type === 'blob' || item.type === 'tree')
            )
            .map((item) => ({
              path: String(item.path),
              type: item.type as 'blob' | 'tree',
              size:
                typeof item.size === 'number' && Number.isFinite(item.size)
                  ? item.size
                  : undefined,
            }));
          if (parsed.length > 0) {
            githubRepoTreeCache.set(repositorySlug, parsed);
            setRepoEntries(parsed);
          }
        }
      )
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [repositorySlug]);

  const effectiveEntries = useMemo(
    () =>
      repoEntries && repoEntries.length > 0
        ? repoEntries
        : entriesFromContents(contents),
    [contents, repoEntries]
  );

  const { nodes: treeNodes, expandableIds } = useMemo(
    () => buildRepoTreeNodes(effectiveEntries, isZh),
    [effectiveEntries, isZh]
  );

  const { visibleData, treeConfig } = useTableTreeState<PackageTreeNode>({
    data: treeNodes,
    idKey: 'id',
    childrenKey: 'children',
    defaultExpandedIds: expandableIds,
    indent: 'sm',
    treeColumnKey: 'name',
  });

  const treePlugin = useTableTreeData<PackageTreeNode>({
    ...treeConfig,
    hasExpandAllControl: true,
    hasRowClickExpansion: true,
  });

  const columns = useMemo<TableColumn<PackageTreeNode>[]>(
    () => [
      {
        key: 'name',
        header: isZh ? '名称' : 'Name',
        width: proportional(1, { minWidth: 200 }),
        renderCell: (row) => (
          <span
            className={`dsh-tree-cell dsh-tree-cell--${row.nodeType}`}
            title={row.id}
          >
            {row.nodeType === 'folder' ? (
              <Folder aria-hidden="true" className="dsh-tree-cell-icon" />
            ) : (
              <FileCode2 aria-hidden="true" className="dsh-tree-cell-icon" />
            )}
            <span className="dsh-tree-cell-name">{row.displayName}</span>
          </span>
        ),
      },
      {
        key: 'kindLabel',
        header: isZh ? '类型' : 'Type',
        width: pixel(120),
        renderCell: (row) => (
          <span className="dsh-tree-kind-badge" data-node-type={row.nodeType}>
            {row.kindLabel}
          </span>
        ),
      },
      {
        key: 'sizeLabel',
        header: isZh ? '大小' : 'Size',
        width: pixel(100),
        align: 'end',
        renderCell: (row) => (
          <span className="dsh-tree-size-label">{row.sizeLabel}</span>
        ),
      },
    ],
    [isZh]
  );

  return (
    <div
      className="dsh-package-tree-direct"
      role="region"
      aria-label={t('plugins.contentTree')}
    >
      <Table<PackageTreeNode>
        data={visibleData}
        idKey="id"
        columns={columns}
        plugins={{ tree: treePlugin }}
        density="compact"
        dividers="rows"
        hasHover
        aria-label={t('plugins.contentTree')}
        className="dsh-package-tree-table"
      />
    </div>
  );
}
