import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { IDockviewPanelProps } from 'dockview-react';
import { Layout, LayoutContent, HStack, VStack } from '@astryxdesign/core/Layout';
import { Toolbar } from '@astryxdesign/core/Toolbar';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Button } from '@astryxdesign/core/Button';
import { Section } from '@astryxdesign/core/Section';
import { Avatar } from '@astryxdesign/core/Avatar';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import {
  ChevronLeft,
  ChevronRight,
  Columns3,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  LayoutGrid,
  List as ListIcon,
  Table2,
} from 'lucide-react';
import type { DirectoryEntry } from 'shared/types';
import { desktopApi, fileSystemApi } from '@/lib/api/misc';
import { pluginControlApi } from '@/lib/api/plugins';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import type { ExternalDirectoryPanelParams } from '@/types/panels';
import { getFilePreviewKind } from '@/utils/filePreviewKind';

const pageStyle: CSSProperties = { height: '100%' };
const columnRowStyle: CSSProperties = { overflowX: 'auto', overflowY: 'hidden' };
const scrollableStyle: CSSProperties = { overflowY: 'auto' };
const fixedColumnStyle: CSSProperties = { flexShrink: 0 };
const detailColumnStyle: CSSProperties = {
  flexGrow: 1,
  flexShrink: 0,
  flexBasis: 320,
};

function normalizeDirPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[a-zA-Z]:[\\/]?$/.test(trimmed)) {
    return `${trimmed[0]}:\\`;
  }
  if (trimmed === '/') return '/';
  return trimmed.replace(/[\\/]+$/, '');
}

function getBaseName(targetPath: string): string {
  const normalized = normalizeDirPath(targetPath);
  if (!normalized) return 'Folder';
  if (/^[a-zA-Z]:\\$/.test(normalized)) return normalized;
  if (normalized === '/') return '/';
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.substring(dot + 1).toUpperCase() : 'File';
}

function fileExtensionLower(filePath: string): string | undefined {
  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : undefined;
}

function formatFileSize(bytes?: bigint | number | null): string {
  if (bytes == null) return '—';
  const num = Number(bytes);
  if (!Number.isFinite(num) || num < 0) return '—';
  if (num < 1024) return `${num} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = num / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTimestamp(msOrSec?: bigint | number | null): string {
  if (msOrSec == null) return '—';
  const raw = Number(msOrSec);
  if (!Number.isFinite(raw) || raw <= 0) return '—';
  const ms = raw < 1e11 ? raw * 1000 : raw;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '—';
  }
}

export function DockviewExternalDirectoryPanel(
  props: IDockviewPanelProps<ExternalDirectoryPanelParams>
) {
  const { t } = useTranslation(['panels', 'common']);
  const panelActions = useOptionalPanelActionsContext();
  const rootPath = useMemo(
    () => normalizeDirPath(props.params?.rootPath ?? ''),
    [props.params?.rootPath]
  );

  const [selectedPath, setSelectedPath] = useState<string[]>([]);
  const [entriesByDir, setEntriesByDir] = useState<
    Record<string, DirectoryEntry[]>
  >({});
  const [loadingByDir, setLoadingByDir] = useState<Record<string, boolean>>({});
  const [errorByDir, setErrorByDir] = useState<Record<string, string | null>>(
    {}
  );
  const [pluginCanPreview, setPluginCanPreview] = useState(false);

  useEffect(() => {
    setSelectedPath([]);
  }, [rootPath]);

  const loadDirectory = useCallback(async (dirPath: string) => {
    const normalized = normalizeDirPath(dirPath);
    if (!normalized) return;

    setLoadingByDir((prev) => ({ ...prev, [normalized]: true }));
    setErrorByDir((prev) => ({ ...prev, [normalized]: null }));

    try {
      const response = await fileSystemApi.list(normalized);
      const entries = (response?.entries ?? []).map((entry) => ({
        ...entry,
        path: normalizeDirPath(entry.path) || entry.path,
      }));
      setEntriesByDir((prev) => ({ ...prev, [normalized]: entries }));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t('externalDirectory.loadFailed', '目录读取失败');
      setErrorByDir((prev) => ({ ...prev, [normalized]: message }));
      setEntriesByDir((prev) => ({ ...prev, [normalized]: [] }));
    } finally {
      setLoadingByDir((prev) => ({ ...prev, [normalized]: false }));
    }
  }, [t]);

  useEffect(() => {
    if (rootPath && !(rootPath in entriesByDir) && !loadingByDir[rootPath]) {
      void loadDirectory(rootPath);
    }
  }, [entriesByDir, loadDirectory, loadingByDir, rootPath]);

  useEffect(() => {
    for (const itemPath of selectedPath) {
      const normalized = normalizeDirPath(itemPath);
      if (!normalized) continue;
      let isDir = false;
      for (const list of Object.values(entriesByDir)) {
        const match = list.find(
          (entry) => normalizeDirPath(entry.path) === normalized
        );
        if (match?.is_directory) {
          isDir = true;
          break;
        }
      }
      if (isDir && !(normalized in entriesByDir) && !loadingByDir[normalized]) {
        void loadDirectory(normalized);
      }
    }
  }, [entriesByDir, loadDirectory, loadingByDir, selectedPath]);

  const findEntryByPath = useCallback(
    (targetPath: string): DirectoryEntry | null => {
      const normalized = normalizeDirPath(targetPath);
      for (const entries of Object.values(entriesByDir)) {
        const found = entries.find(
          (item) => normalizeDirPath(item.path) === normalized
        );
        if (found) return found;
      }
      return null;
    },
    [entriesByDir]
  );

  const columns = useMemo(() => {
    if (!rootPath) return [];
    const cols: {
      dirPath: string;
      items: DirectoryEntry[];
      selectedId: string | null;
      isLoading: boolean;
      error: string | null;
    }[] = [];

    cols.push({
      dirPath: rootPath,
      items: entriesByDir[rootPath] ?? [],
      selectedId: selectedPath[0] ?? null,
      isLoading: Boolean(loadingByDir[rootPath]),
      error: errorByDir[rootPath] ?? null,
    });

    let currentItems = entriesByDir[rootPath] ?? [];
    for (let i = 0; i < selectedPath.length; i += 1) {
      const targetId = normalizeDirPath(selectedPath[i]);
      const selected = currentItems.find(
        (item) => normalizeDirPath(item.path) === targetId
      );
      if (selected?.is_directory) {
        const childDirPath = normalizeDirPath(selected.path);
        const childItems = entriesByDir[childDirPath] ?? [];
        cols.push({
          dirPath: childDirPath,
          items: childItems,
          selectedId: selectedPath[i + 1] ?? null,
          isLoading: Boolean(loadingByDir[childDirPath]),
          error: errorByDir[childDirPath] ?? null,
        });
        currentItems = childItems;
      } else {
        break;
      }
    }

    return cols;
  }, [entriesByDir, errorByDir, loadingByDir, rootPath, selectedPath]);

  const currentFolderEntry = useMemo(() => {
    if (selectedPath.length === 0) return null;
    const lastId = selectedPath[selectedPath.length - 1];
    const entry = findEntryByPath(lastId);
    if (entry?.is_directory) return entry;
    if (selectedPath.length >= 2) {
      const parent = findEntryByPath(selectedPath[selectedPath.length - 2]);
      if (parent?.is_directory) return parent;
    }
    return null;
  }, [findEntryByPath, selectedPath]);

  const currentFolderPath = currentFolderEntry?.path ?? rootPath;
  const currentFolderName = useMemo(() => {
    if (currentFolderEntry) return currentFolderEntry.name;
    return getBaseName(rootPath);
  }, [currentFolderEntry, rootPath]);

  const selectedFile = useMemo(() => {
    if (selectedPath.length === 0) return null;
    const lastId = selectedPath[selectedPath.length - 1];
    const item = findEntryByPath(lastId);
    return item && !item.is_directory ? item : null;
  }, [findEntryByPath, selectedPath]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedFile) {
      setPluginCanPreview(false);
      return;
    }
    const ext = fileExtensionLower(selectedFile.path);
    void pluginControlApi
      .resolveFileOpener(ext)
      .then((opener) => {
        if (!cancelled) {
          setPluginCanPreview(Boolean(opener));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPluginCanPreview(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFile]);

  const canPreviewSelectedFile = useMemo(() => {
    if (!selectedFile) return false;
    return (
      getFilePreviewKind(selectedFile.path) !== 'binary' || pluginCanPreview
    );
  }, [pluginCanPreview, selectedFile]);

  const handleSelect = (columnIndex: number, itemPath: string) => {
    const normalized = normalizeDirPath(itemPath);
    setSelectedPath([...selectedPath.slice(0, columnIndex), normalized]);
  };

  const handleOpenInFileManager = () => {
    const targetPath = selectedFile?.path ?? currentFolderPath;
    if (!targetPath) return;
    void desktopApi.revealInFileManager(targetPath);
  };

  const handleOpenInTab = () => {
    if (!selectedFile) return;
    panelActions?.openFilePreview(selectedFile.path, {
      title: selectedFile.name,
      displayPath: selectedFile.path,
    });
  };

  return (
    <div
      className="h-full w-full"
      data-testid="dockview-external-directory-panel"
    >
      <Layout
        style={pageStyle}
        height="fill"
        header={
          <Toolbar
            label={t('panelRegistry.externalDirectory', '目录浏览')}
            size="sm"
            dividers={['bottom']}
            startContent={
              <>
                <IconButton
                  variant="ghost"
                  size="sm"
                  icon={<Icon icon={ChevronLeft} size="sm" />}
                  onClick={() => {
                    if (selectedPath.length > 0) {
                      setSelectedPath(selectedPath.slice(0, -1));
                    }
                  }}
                  isDisabled={selectedPath.length === 0}
                  label={t('externalDirectory.goBack', '返回上一级')}
                />
                <IconButton
                  variant="ghost"
                  size="sm"
                  icon={<Icon icon={ChevronRight} size="sm" />}
                  isDisabled
                  label={t('externalDirectory.goForward', '前进')}
                />
                <Text type="label">{currentFolderName}</Text>
              </>
            }
            centerContent={
              <SegmentedControl
                value="column"
                onChange={() => {}}
                label={t('externalDirectory.viewMode', '视图模式')}
              >
                <SegmentedControlItem
                  value="grid"
                  label="Grid"
                  icon={<Icon icon={LayoutGrid} size="sm" />}
                  isLabelHidden
                />
                <SegmentedControlItem
                  value="list"
                  label="List"
                  icon={<Icon icon={ListIcon} size="sm" />}
                  isLabelHidden
                />
                <SegmentedControlItem
                  value="column"
                  label="Column"
                  icon={<Icon icon={Columns3} size="sm" />}
                  isLabelHidden
                />
                <SegmentedControlItem
                  value="gallery"
                  label="Gallery"
                  icon={<Icon icon={Table2} size="sm" />}
                  isLabelHidden
                />
              </SegmentedControl>
            }
            endContent={
              <Button
                label={t('ui.preview.openInFolder', '在文件夹中打开')}
                variant="secondary"
                size="sm"
                icon={<Icon icon={FolderOpen} size="sm" />}
                onClick={handleOpenInFileManager}
              />
            }
          />
        }
        content={
          <LayoutContent padding={0} isScrollable={false}>
            <HStack height="100%" style={columnRowStyle}>
              {columns.map((col, colIndex) => {
                const showDivider =
                  colIndex < columns.length - 1 || selectedFile != null;
                return (
                  <Section
                    key={col.dirPath}
                    width={240}
                    padding={2}
                    variant="transparent"
                    dividers={showDivider ? ['end'] : undefined}
                    style={{ ...scrollableStyle, ...fixedColumnStyle }}
                  >
                    {col.isLoading ? (
                      <VStack padding={3}>
                        <Text type="supporting">
                          {t('fileTreeMenu.loading', '加载中...')}
                        </Text>
                      </VStack>
                    ) : col.error ? (
                      <VStack padding={3}>
                        <Text type="supporting">{col.error}</Text>
                      </VStack>
                    ) : col.items.length === 0 ? (
                      <VStack padding={3}>
                        <Text type="supporting">
                          {t('externalDirectory.emptyFolder', '文件夹为空')}
                        </Text>
                      </VStack>
                    ) : (
                      <List density="compact" hasDividers={false}>
                        {col.items.map((item) => {
                          const itemId = normalizeDirPath(item.path);
                          const isSelected =
                            normalizeDirPath(col.selectedId ?? '') === itemId;
                          return (
                            <ListItem
                              key={item.path}
                              label={item.name}
                              startContent={
                                <Icon
                                  icon={item.is_directory ? Folder : FileText}
                                  color={
                                    item.is_directory ? 'accent' : 'secondary'
                                  }
                                  size="sm"
                                />
                              }
                              endContent={
                                item.is_directory ? (
                                  <Icon
                                    icon={ChevronRight}
                                    size="xsm"
                                    color="secondary"
                                  />
                                ) : undefined
                              }
                              onClick={() => handleSelect(colIndex, item.path)}
                              isSelected={isSelected}
                            />
                          );
                        })}
                      </List>
                    )}
                  </Section>
                );
              })}
              {selectedFile && (
                <Section
                  padding={6}
                  variant="transparent"
                  style={{ ...scrollableStyle, ...detailColumnStyle }}
                >
                  <VStack gap={4} hAlign="center">
                    <Avatar name={selectedFile.name} size={96} />
                    <VStack gap={1} hAlign="center">
                      <Text type="label">{selectedFile.name}</Text>
                      <Text type="supporting">
                        {getFileExtension(selectedFile.name)} Document
                      </Text>
                    </VStack>
                    <MetadataList
                      title={t('externalDirectory.information', 'Information')}
                    >
                      <MetadataListItem
                        label={t('externalDirectory.created', 'Created')}
                      >
                        {formatTimestamp(selectedFile.created_at_ms)}
                      </MetadataListItem>
                      <MetadataListItem
                        label={t('externalDirectory.modified', 'Modified')}
                      >
                        {formatTimestamp(
                          selectedFile.modified_at_ms ??
                            selectedFile.last_modified
                        )}
                      </MetadataListItem>
                      <MetadataListItem
                        label={t('externalDirectory.kind', 'Kind')}
                      >
                        {getFileExtension(selectedFile.name)} Document
                      </MetadataListItem>
                      <MetadataListItem
                        label={t('externalDirectory.size', 'Size')}
                      >
                        {formatFileSize(selectedFile.size_bytes)}
                      </MetadataListItem>
                    </MetadataList>
                    {canPreviewSelectedFile ? (
                      <Button
                        label={t('externalDirectory.openInTab', '在标签页打开')}
                        variant="primary"
                        size="sm"
                        icon={<Icon icon={ExternalLink} size="sm" />}
                        onClick={handleOpenInTab}
                      />
                    ) : null}
                  </VStack>
                </Section>
              )}
            </HStack>
          </LayoutContent>
        }
      />
    </div>
  );
}

export default DockviewExternalDirectoryPanel;
