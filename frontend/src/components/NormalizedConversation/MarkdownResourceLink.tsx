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
  if (isAbsoluteLocalPath(candidate)) return true;
  return /[\\/]/.test(candidate);
}

export function resolveMarkdownWorkspacePathTarget(
  href: string | undefined,
  childrenText: string,
  workspacePath?: string | null
): WorkspacePathTarget | null {
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
