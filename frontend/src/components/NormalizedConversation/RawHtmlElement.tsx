import { useCallback, useEffect, useRef } from 'react';
import DOMPurify, { type Config } from 'dompurify';
import { convertFileSrc } from '@tauri-apps/api/core';
import { RAW_HTML_ALLOWED_TAGS } from '@/lib/conversation-rendering/rawHtml';
import {
  isRenderableRemoteImage,
  resolveLocalMarkdownImagePath,
} from './localImagePaths';

/**
 * DOMPurify configuration for raw HTML injected by the markdown renderer.
 * Kept intentionally narrow: only the same tags the detector allowlists, only
 * safe attributes, no data-/aria- attributes. `style`, event handlers,
 * `srcdoc` and `<script>` are stripped by DOMPurify automatically.
 */
export const RAW_HTML_DOMPURIFY_CONFIG: Config = {
  ALLOWED_TAGS: [...RAW_HTML_ALLOWED_TAGS],
  ALLOWED_ATTR: [
    'href',
    'src',
    'srcset',
    'alt',
    'title',
    'width',
    'height',
    'colspan',
    'rowspan',
    'start',
    'type',
    'datetime',
    'cite',
    'open',
    'download',
    'loading',
    'referrerpolicy',
  ],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

export function sanitizeRawHtml(html: string): string {
  return DOMPurify.sanitize(html, RAW_HTML_DOMPURIFY_CONFIG);
}

function buildSanitizedNodes(
  html: string,
  workspacePath?: string | null
): ChildNode[] {
  const container = document.createElement('div');
  container.innerHTML = sanitizeRawHtml(html);

  // Relative image destinations from raw HTML resolve the same way markdown
  // image destinations do: against the containing markdown file's directory
  // (or the workspace root). Remote / inline / absolute paths are untouched.
  container.querySelectorAll('img[src]').forEach((image) => {
    const src = image.getAttribute('src');
    if (!src || isRenderableRemoteImage(src)) return;
    const localPath = resolveLocalMarkdownImagePath(src, workspacePath);
    if (localPath) image.setAttribute('src', convertFileSrc(localPath));
  });

  return Array.from(container.childNodes);
}

/**
 * Renders raw HTML that `protectRawHtml` captured into a markdown placeholder.
 *
 * The content is sanitized through DOMPurify on every change and mounted via
 * `replaceChildren` — DOM-level rewriting (rather than a second
 * `dangerouslySetInnerHTML` pass) so rewritten image `src` attributes are set
 * before the browser begins fetching them.
 */
export function RawHtmlElement({
  html,
  block,
  workspacePath,
}: {
  html: string;
  block: boolean;
  workspacePath?: string | null;
}) {
  const hostRef = useRef<HTMLElement | null>(null);
  const attachRef = useCallback((node: HTMLElement | null) => {
    hostRef.current = node;
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren(...buildSanitizedNodes(html, workspacePath));
  }, [html, workspacePath]);

  if (block) {
    return <div ref={attachRef} className="conv-md-raw-html" />;
  }
  return <span ref={attachRef} className="conv-md-raw-html" />;
}
