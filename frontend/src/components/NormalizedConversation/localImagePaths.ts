import {
  isAbsoluteLocalPath,
  trimFilePathCandidate,
} from './MarkdownResourceLink';

/** Remote / inline / blob images render as-is (no local file resolution). */
export function isRenderableRemoteImage(src: string): boolean {
  return (
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('data:image/') ||
    src.startsWith('blob:')
  );
}

export function isMarkdownImagePath(value: string): boolean {
  const candidate = trimFilePathCandidate(value);
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)(?:[?#].*)?$/i.test(candidate);
}

/**
 * Resolve an image destination from markdown to an absolute local path.
 *
 * `workspacePath` is the base directory relative markdown paths are resolved
 * against (the containing directory of a markdown file, or a task workspace
 * root in conversation rendering).
 */
export function resolveLocalMarkdownImagePath(
  src: string,
  workspacePath?: string | null
): string | null {
  if (!src) return null;
  if (src.startsWith('file://')) {
    return src.replace(/^file:\/\//i, '');
  }
  if (isAbsoluteLocalPath(src)) {
    return src;
  }
  if (!workspacePath || src.includes('://') || src.startsWith('#')) {
    return null;
  }

  const normalizedRelative = src.replace(/^\.?[\\/]/, '');
  return `${workspacePath.replace(/[\\/]+$/, '')}/${normalizedRelative}`;
}
