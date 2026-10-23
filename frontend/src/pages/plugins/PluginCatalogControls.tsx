import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  FolderArchive,
  GitBranch,
  Loader2,
  PackageOpen,
  Store,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { PluginImportPreview } from '@/lib/api/plugins';
import { PluginProductIcon } from './OfficialPluginIcon';
import { formatPluginVersion } from './PluginAttributeBadges';
import { officialPluginName } from './officialPlugins';
import { errorMessage } from './pluginQueries';

export const OFFICIAL_MARKETPLACE_WEB_URL =
  'https://vibex.xforever.xin/marketplace';

export function normalizeGithubRepositoryInput(
  rawInput: string
): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;
  if (/^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+/i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '');
  }
  if (/^github\.com\/[^/\s]+\/[^/\s]+/i.test(trimmed)) {
    return `https://${trimmed.replace(/\/+$/, '')}`;
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}`;
  }
  return null;
}

export function PluginCatalogActions({
  canAdd,
  adding,
  search,
  onAdd,
  onPullGithubRepo,
  onConfirmGithubInstall,
  onOpenExternalMarketplace,
}: {
  canAdd: boolean;
  adding: boolean;
  search?: ReactNode;
  onAdd: () => void;
  onPullGithubRepo?: (repoUrl: string) => Promise<PluginImportPreview>;
  onConfirmGithubInstall?: (
    preview: PluginImportPreview,
    repoUrl: string
  ) => void | Promise<void>;
  onOpenExternalMarketplace?: () => void | Promise<void>;
}) {
  const { t, i18n } = useTranslation('settings');
  const isZh = i18n.language.toLowerCase().startsWith('zh');
  const [menuOpen, setMenuOpen] = useState(false);
  const [githubPopOpen, setGithubPopOpen] = useState(false);
  const [repoInput, setRepoInput] = useState('');
  const [pullState, setPullState] = useState<
    'idle' | 'pulling' | 'success' | 'error'
  >('idle');
  const [pullError, setPullError] = useState<string | null>(null);
  const [pulledPreview, setPulledPreview] =
    useState<PluginImportPreview | null>(null);
  const [normalizedRepoUrl, setNormalizedRepoUrl] = useState<string>('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!menuOpen && !githubPopOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setMenuOpen(false);
        if (pullState !== 'pulling') {
          setGithubPopOpen(false);
        }
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        if (pullState !== 'pulling') {
          setGithubPopOpen(false);
        }
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [githubPopOpen, menuOpen, pullState]);

  useEffect(() => {
    if (githubPopOpen) {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [githubPopOpen]);

  const handleSelectPackage = () => {
    setMenuOpen(false);
    setGithubPopOpen(false);
    onAdd();
  };

  const handleSelectGithub = () => {
    setMenuOpen(false);
    setPullState('idle');
    setPullError(null);
    setPulledPreview(null);
    setGithubPopOpen(true);
  };

  const handleSelectMarketplace = () => {
    setMenuOpen(false);
    setGithubPopOpen(false);
    if (onOpenExternalMarketplace) {
      void onOpenExternalMarketplace();
    } else if (typeof window !== 'undefined') {
      window.open(
        OFFICIAL_MARKETPLACE_WEB_URL,
        '_blank',
        'noopener,noreferrer'
      );
    }
  };

  const handlePull = async () => {
    const normalized = normalizeGithubRepositoryInput(repoInput);
    if (!normalized) {
      setPullState('error');
      setPullError(
        isZh
          ? '请输入有效的 GitHub 仓库地址（例如 https://github.com/owner/repo）'
          : 'Please enter a valid GitHub repository URL'
      );
      setPulledPreview(null);
      return;
    }
    if (!onPullGithubRepo) return;
    setPullState('pulling');
    setPullError(null);
    setPulledPreview(null);
    setNormalizedRepoUrl(normalized);
    try {
      const preview = await onPullGithubRepo(normalized);
      setPulledPreview(preview);
      setPullState('success');
    } catch (error) {
      setPulledPreview(null);
      setPullState('error');
      setPullError(errorMessage(error));
    }
  };

  const handleConfirmGithub = async () => {
    if (!pulledPreview || !onConfirmGithubInstall) return;
    const preview = pulledPreview;
    const repoUrl = normalizedRepoUrl || repoInput.trim();
    setGithubPopOpen(false);
    setPullState('idle');
    setPulledPreview(null);
    setRepoInput('');
    await onConfirmGithubInstall(preview, repoUrl);
  };

  return (
    <div className="product-plugins-header-actions">
      {search}
      {canAdd ? (
        <div ref={containerRef} className="dsh-add-plugin-anchor">
          <Button
            type="button"
            className="dsh-add-plugin-button"
            disabled={adding}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => {
              setGithubPopOpen(false);
              setMenuOpen((prev) => !prev);
            }}
          >
            <span className="dsh-add-plugin-label">
              {adding ? (
                <Loader2
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin"
                />
              ) : null}
              <span>{t('plugins.addPlugin')}</span>
            </span>
            <span aria-hidden="true" className="dsh-add-plugin-divider" />
            <span aria-hidden="true" className="dsh-add-plugin-caret-cell">
              <ChevronDown
                aria-hidden="true"
                className="dsh-add-plugin-caret h-3.5 w-3.5"
              />
            </span>
          </Button>

          {menuOpen ? (
            <div
              className="dsh-add-plugin-menu"
              role="menu"
              aria-label={t('plugins.addPlugin')}
            >
              <button
                type="button"
                role="menuitem"
                className="dsh-add-plugin-menu-item"
                onClick={handleSelectPackage}
              >
                <FolderArchive
                  aria-hidden="true"
                  className="dsh-add-menu-icon"
                />
                <span>{isZh ? '安装包' : 'Package Archive'}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="dsh-add-plugin-menu-item"
                onClick={handleSelectGithub}
              >
                <GitBranch aria-hidden="true" className="dsh-add-menu-icon" />
                <span>{isZh ? 'GitHub仓库' : 'GitHub Repository'}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="dsh-add-plugin-menu-item"
                onClick={handleSelectMarketplace}
              >
                <Store aria-hidden="true" className="dsh-add-menu-icon" />
                <span>{isZh ? '插件市场' : 'Plugin Marketplace'}</span>
                <ExternalLink
                  aria-hidden="true"
                  className="dsh-add-menu-trailing"
                />
              </button>
            </div>
          ) : null}

          {githubPopOpen ? (
            <div
              className="dsh-github-popconfirm"
              role="dialog"
              aria-label={
                isZh ? '从 GitHub 仓库拉取插件' : 'Pull plugin from GitHub'
              }
            >
              <div className="dsh-github-popconfirm-head">
                <GitBranch aria-hidden="true" className="h-3.5 w-3.5" />
                <strong>
                  {isZh
                    ? '从 GitHub 仓库添加插件'
                    : 'Add from GitHub Repository'}
                </strong>
              </div>

              <div className="dsh-github-popconfirm-input-row">
                <input
                  ref={inputRef}
                  type="url"
                  className="dsh-github-popconfirm-input"
                  value={repoInput}
                  disabled={pullState === 'pulling'}
                  placeholder="https://github.com/owner/repo"
                  aria-label={isZh ? 'GitHub仓库地址' : 'GitHub repository URL'}
                  onChange={(event) => {
                    setRepoInput(event.target.value);
                    if (pullState === 'error') {
                      setPullState('idle');
                      setPullError(null);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handlePull();
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={pullState === 'pulling' || !repoInput.trim()}
                  onClick={() => void handlePull()}
                >
                  {pullState === 'pulling' ? (
                    <Loader2
                      aria-hidden="true"
                      className="h-3.5 w-3.5 animate-spin"
                    />
                  ) : null}
                  {isZh ? '拉取' : 'Pull'}
                </Button>
              </div>

              {pullState === 'pulling' ? (
                <div
                  className="dsh-github-pull-status"
                  data-status="pulling"
                  role="status"
                >
                  <div className="dsh-github-pull-status-line">
                    <Loader2
                      aria-hidden="true"
                      className="h-3.5 w-3.5 animate-spin"
                    />
                    <span>
                      {isZh
                        ? '正在拉取仓库并解析插件包...'
                        : 'Pulling repository and inspecting package...'}
                    </span>
                  </div>
                  <div className="dsh-github-pull-progress" aria-hidden="true">
                    <span className="dsh-github-pull-progress-bar" />
                  </div>
                </div>
              ) : null}

              {pullState === 'error' ? (
                <div
                  className="dsh-github-pull-status"
                  data-status="error"
                  role="alert"
                >
                  <div className="dsh-github-pull-status-line">
                    <AlertCircle aria-hidden="true" className="h-3.5 w-3.5" />
                    <span>
                      {isZh ? '拉取失败：' : 'Pull failed: '}
                      {pullError}
                    </span>
                  </div>
                </div>
              ) : null}

              {pullState === 'success' && pulledPreview ? (
                <div
                  className="dsh-github-pull-status"
                  data-status="success"
                  role="status"
                >
                  <div className="dsh-github-pull-status-line">
                    <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
                    <span>{isZh ? '拉取成功' : 'Pull succeeded'}</span>
                  </div>
                  <div
                    className="dsh-github-plugin-minicard"
                    data-testid="github-pulled-plugin-card"
                  >
                    <PluginProductIcon pluginId={pulledPreview.plugin.id} />
                    <div className="dsh-github-plugin-minicard-copy">
                      <strong className="dsh-github-plugin-minicard-name">
                        {officialPluginName(
                          pulledPreview.plugin.id,
                          pulledPreview.plugin.name,
                          t
                        )}
                      </strong>
                      <span className="dsh-github-plugin-minicard-meta">
                        {formatPluginVersion(pulledPreview.plugin.version)}
                      </span>
                    </div>
                  </div>
                  <div className="dsh-github-popconfirm-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setGithubPopOpen(false);
                        setPullState('idle');
                        setPulledPreview(null);
                      }}
                    >
                      {t('plugins.cancel')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void handleConfirmGithub()}
                    >
                      {t('plugins.install')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function PluginDropOverlay({
  active,
  installing,
}: {
  active: boolean;
  installing: boolean;
}) {
  const { t } = useTranslation('settings');
  if (!active && !installing) return null;

  const label = t(
    installing ? 'plugins.installingPlugin' : 'plugins.dropToInstall'
  );

  return (
    <div
      className="product-plugin-drop-overlay"
      role="status"
      aria-label={label}
    >
      {installing ? (
        <Loader2 aria-hidden="true" className="animate-spin" />
      ) : (
        <PackageOpen aria-hidden="true" />
      )}
      <strong>{label}</strong>
    </div>
  );
}

export function PluginCatalogLoading() {
  const { t } = useTranslation('settings');

  return (
    <div
      className="product-plugin-loading"
      role="status"
      aria-label={t('plugins.loadingPlugins')}
    >
      {[0, 1, 2].map((row) => (
        <div className="product-plugin-loading-row" key={row}>
          <Skeleton className="h-12 w-12 shrink-0 rounded-xl" />
          <span className="product-plugin-loading-copy">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-3/5" />
          </span>
          <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function PluginDetailLoading() {
  const { t } = useTranslation('settings');

  return (
    <div
      className="product-plugin-detail-loading"
      role="status"
      aria-label={t('plugins.loadingPluginDetail')}
    >
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
}
