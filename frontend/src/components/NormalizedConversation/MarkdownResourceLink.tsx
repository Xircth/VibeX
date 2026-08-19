import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { Globe2, Link2 } from 'lucide-react';

import FileIcon from '@/components/FileIcon';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { useOpenLink } from '@/hooks/useOpenLink';
import {
  deriveRelativeFilePath,
  resolveFilePathFromRoot,
} from '@/utils/filePaths';

export type WorkspacePathTarget = {
  path: string;
  displayPath: string;
  nodeType: 'file' | 'folder';
};

export function trimFilePathCandidate(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+/, '')
    .replace(/['"`.,;]+$/, '')
    .replace(/[)\]}]+$/, '')
    .replace(/#L\d+(?:-L?\d+)?$/i, '')
    .replace(/:(\d+)(?::\d+)?$/, '');
}

export function isAbsoluteLocalPath(src: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(src) ||
    src.startsWith('\\\\') ||
    src.startsWith('/') ||
    src.startsWith('file://')
  );
}

function parseHref(href: string): URL | null {
  try {
    return new URL(href, window.location.origin);
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  );
}

function isInternalProjectRouteHref(href: string): boolean {
  const parsed = parseHref(href);
  if (!parsed) return href.startsWith('/local-projects');

  return (
    parsed.pathname.startsWith('/local-projects') &&
    (parsed.origin === window.location.origin ||
      isLoopbackHost(parsed.hostname))
  );
}

function isSameAppOriginUrl(url: URL): boolean {
  return (
    url.origin === window.location.origin ||
    (url.protocol === window.location.protocol && isLoopbackHost(url.hostname))
  );
}

function filePathFromFileUrl(url: URL): string {
  const pathname = decodeURIComponent(url.pathname);
  return pathname.replace(/^\/([a-zA-Z]:[\\/])/, '$1');
}

function hrefToWorkspacePathCandidate(
  href: string | undefined,
  workspacePath?: string | null
): string | null {
  if (!href) return null;
  const raw = trimFilePathCandidate(href);
  if (!raw || raw.startsWith('#')) return null;

  const parsed = parseHref(raw);
  if (parsed?.protocol === 'file:') {
    return filePathFromFileUrl(parsed);
  }

  // A leading slash is an absolute local path on POSIX. Preserve it before
  // URL parsing can reinterpret it as a same-origin web path and strip the
  // root slash, which would cause the workspace root to be joined twice.
  if (
    raw.startsWith('/') &&
    !(workspacePath && /^[a-zA-Z]:[\\/]/.test(workspacePath))
  ) {
    return raw;
  }

  if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    if (!isSameAppOriginUrl(parsed)) return null;
    if (parsed.pathname.startsWith('/local-projects')) return null;
    return decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  }

  if (
    raw.startsWith('/') &&
    workspacePath &&
    /^[a-zA-Z]:[\\/]/.test(workspacePath)
  ) {
    return raw.replace(/^\/+/, '');
  }

  return raw;
}

function looksLikeWorkspaceFilePath(value: string): boolean {
  const candidate = trimFilePathCandidate(value);
  if (!candidate || candidate.startsWith('#')) return false;
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(candidate) &&
    !isAbsoluteLocalPath(candidate)
  ) {
    return false;
  }
  if (candidate.startsWith('/local-projects')) return false;
  if (isAbsoluteLocalPath(candidate)) {
    return /(?:^|[\\/])[^\\/]+\.[a-z0-9]{1,12}$/i.test(
      candidate.replace(/[\\/]+$/, '')
    );
  }

  return (
    /[\\/]/.test(candidate) &&
    /(?:^|[\\/])[^\\/]+\.[a-z0-9]{1,12}$/i.test(candidate)
  );
}

const WORKSPACE_ROOT_SEGMENTS = new Set([
  'src',
  'lib',
  'libs',
  'app',
  'apps',
  'bin',
  'cmd',
  'pkg',
  'web',
  'www',
  'api',
  'ui',
  'frontend',
  'backend',
  'server',
  'client',
  'crates',
  'packages',
  'package',
  'docs',
  'doc',
  'test',
  'tests',
  'scripts',
  'script',
  'assets',
  'public',
  'static',
  'config',
  'configs',
  'tools',
  'tool',
  'vendor',
  'third_party',
  'third-party',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'include',
  'internal',
  'examples',
  'example',
  'fixtures',
  'migrations',
  'components',
  'pages',
  'hooks',
  'utils',
  'types',
  'shared',
  'desktop',
  'mobile',
  'contents',
  'plugins',
  'plugin',
  'modules',
  'services',
  'features',
  'stores',
  'models',
  'views',
  'routes',
  'helpers',
  'constants',
  'schemas',
  'resources',
  'images',
  'icons',
  'fonts',
  'data',
  'locales',
  'i18n',
  'styles',
]);

const GITHUB_OWNER_PATTERN =
  /^(?=.{1,39}$)[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/;
const GITHUB_REPO_PATTERN = /^(?=.{1,100}$)[A-Za-z0-9._-]+$/;

function looksLikeGithubRepoShorthand(value: string): boolean {
  const candidate = trimFilePathCandidate(value).replace(/[\\/]+$/, '');
  if (!candidate || candidate.includes('\\')) return false;
  const segments = candidate.split('/');
  if (segments.length !== 2) return false;
  const [owner, repo] = segments;
  if (!owner || !repo || repo === '.' || repo === '..') return false;
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo)) {
    return false;
  }
  if (WORKSPACE_ROOT_SEGMENTS.has(owner.toLowerCase())) return false;
  if (WORKSPACE_ROOT_SEGMENTS.has(repo.toLowerCase())) return false;
  return true;
}

export function githubRepoUrlFromShorthand(value: string): string | null {
  const candidate = trimFilePathCandidate(value).replace(/[\\/]+$/, '');
  return looksLikeGithubRepoShorthand(candidate)
    ? `https://github.com/${candidate}`
    : null;
}

function looksLikeWorkspaceDirectoryPath(value: string): boolean {
  const candidate = trimFilePathCandidate(value).replace(/[\\/]+$/, '');
  if (!candidate || candidate === '.' || candidate.startsWith('#')) {
    return false;
  }
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(candidate) &&
    !isAbsoluteLocalPath(candidate)
  ) {
    return false;
  }
  if (candidate.startsWith('/local-projects')) return false;
  if (looksLikeWorkspaceFilePath(candidate)) return false;
  if (looksLikeGithubRepoShorthand(candidate)) return false;
  if (isAbsoluteLocalPath(candidate)) return true;
  return /[\\/]/.test(candidate);
}

function isExternalWebHref(href: string | undefined): boolean {
  if (!href) return false;
  const url = externalHttpUrl(href);
  if (!url) return false;
  if (isSameAppOriginUrl(url)) return false;
  if (isInternalProjectRouteHref(href)) return false;
  return true;
}

export function resolveMarkdownWorkspacePathTarget(
  href: string | undefined,
  childrenText: string,
  workspacePath?: string | null
): WorkspacePathTarget | null {
  if (isExternalWebHref(href)) return null;

  const candidates = [
    childrenText,
    hrefToWorkspacePathCandidate(href, workspacePath) ?? '',
    href ?? '',
  ]
    .map(trimFilePathCandidate)
    .filter(Boolean);

  for (const candidate of candidates) {
    const nodeType = looksLikeWorkspaceFilePath(candidate)
      ? 'file'
      : looksLikeWorkspaceDirectoryPath(candidate)
        ? 'folder'
        : null;
    if (!nodeType) continue;

    const normalizedCandidate =
      nodeType === 'folder' ? candidate.replace(/[\\/]+$/, '') : candidate;
    const filePath = resolveFilePathFromRoot(
      normalizedCandidate,
      workspacePath
    );
    const displayPath =
      deriveRelativeFilePath(filePath, workspacePath) ?? normalizedCandidate;
    return { path: filePath, displayPath, nodeType };
  }

  return null;
}

export function isCleanDirectoryCandidate(text: string): boolean {
  return !/[\s*?<>|"']/.test(text);
}

export function resolveMarkdownInlineResource(
  text: string,
  workspacePath?: string | null
): { href?: string; pathTarget?: WorkspacePathTarget } | null {
  const pathTarget = resolveMarkdownWorkspacePathTarget(
    undefined,
    text,
    workspacePath
  );
  if (pathTarget?.nodeType === 'file') return { pathTarget };
  const githubHref = githubRepoUrlFromShorthand(text);
  if (githubHref) return { href: githubHref };
  if (pathTarget?.nodeType === 'folder' && isCleanDirectoryCandidate(text)) {
    return { pathTarget };
  }
  return null;
}

function externalHttpUrl(href: string | undefined): URL | null {
  if (!href) return null;
  const normalized = href.startsWith('www.') ? `https://${href}` : href;
  try {
    const url = new URL(normalized);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function WebsiteIcon({ href }: { href: string }) {
  const [failed, setFailed] = useState(false);
  const url = externalHttpUrl(href);
  const faviconUrl = url ? `${url.origin}/favicon.ico` : null;

  useEffect(() => setFailed(false), [faviconUrl]);

  if (!faviconUrl || failed) {
    return (
      <Globe2
        aria-hidden="true"
        className="conv-resource-link-icon"
        data-resource-icon="web"
      />
    );
  }

  return (
    <img
      alt=""
      className="conv-resource-link-icon conv-resource-link-favicon"
      data-resource-icon="web"
      draggable={false}
      referrerPolicy="no-referrer"
      src={faviconUrl}
      onError={() => setFailed(true)}
    />
  );
}

function flattenNodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenNodeText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return flattenNodeText(
      (node as { props?: { children?: ReactNode } }).props?.children
    );
  }
  return '';
}

export function MarkdownResourceLink({
  href,
  children,
  workspacePath,
  pathTarget: suppliedPathTarget,
}: {
  href?: string;
  children: ReactNode;
  workspacePath?: string | null;
  pathTarget?: WorkspacePathTarget | null;
}) {
  const panelActions = useOptionalPanelActionsContext();
  const openLink = useOpenLink();
  const label = flattenNodeText(children);
  const pathTarget =
    suppliedPathTarget ??
    resolveMarkdownWorkspacePathTarget(href, label, workspacePath);
  const webUrl = pathTarget ? null : externalHttpUrl(href);
  const internalProjectRoute = href ? isInternalProjectRouteHref(href) : false;
  const renderedHref =
    webUrl && !internalProjectRoute ? webUrl.href : undefined;
  const kind = pathTarget?.nodeType ?? (webUrl ? 'web' : 'link');

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (pathTarget) {
      event.preventDefault();
      event.stopPropagation();
      if (pathTarget.nodeType === 'file') {
        panelActions?.openFilePreview(pathTarget.path, {
          displayPath: pathTarget.displayPath,
          title: pathTarget.displayPath,
        });
      } else {
        panelActions?.revealInFileTree(pathTarget.path, {
          displayPath: pathTarget.displayPath,
          nodeType: 'folder',
        });
      }
      return;
    }

    if (!renderedHref) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    openLink(renderedHref);
  };

  return (
    <a
      className="conv-resource-link"
      data-resource-kind={kind}
      href={renderedHref}
      onClick={handleClick}
      onKeyDown={(event) => {
        if (!renderedHref && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
      rel={renderedHref ? 'noopener noreferrer' : undefined}
      role={renderedHref ? undefined : 'link'}
      tabIndex={renderedHref ? undefined : 0}
      title={pathTarget?.displayPath ?? href}
    >
      {pathTarget ? (
        <span
          className="conv-resource-link-icon conv-resource-link-file-icon"
          data-resource-icon={pathTarget.nodeType}
        >
          <FileIcon
            filePath={pathTarget.path}
            isFolder={pathTarget.nodeType === 'folder'}
          />
        </span>
      ) : webUrl ? (
        <WebsiteIcon href={webUrl.href} />
      ) : (
        <Link2
          aria-hidden="true"
          className="conv-resource-link-icon"
          data-resource-icon="link"
        />
      )}
      <span className="conv-resource-link-label">{children}</span>
    </a>
  );
}
