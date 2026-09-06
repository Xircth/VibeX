import { stripWindowsExtendedPathPrefix } from '@/utils/displayPath';

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
]);

export function hostPathFileName(path: string): string {
  const normalized = stripWindowsExtendedPathPrefix(path).replace(
    /[\\/]+$/,
    ''
  );
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || isImageHostPath(file.name);
}

export function isImageHostPath(path: string): boolean {
  const name = hostPathFileName(path);
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function mimeForHostPath(path: string): string {
  const name = hostPathFileName(path);
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

export function relativePathInsideRoot(
  root: string | undefined,
  absolutePath: string
): string | null {
  if (!root) return null;
  const normalizedRoot = stripWindowsExtendedPathPrefix(root)
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/');
  const normalizedPath = stripWindowsExtendedPathPrefix(absolutePath).replace(
    /\\/g,
    '/'
  );
  if (normalizedPath === normalizedRoot) return '';
  const prefix = `${normalizedRoot}/`;
  const pathMatches =
    normalizedPath.startsWith(prefix) ||
    normalizedPath.toLowerCase().startsWith(prefix.toLowerCase());
  if (!pathMatches) return null;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

export function isPointInElement(
  element: HTMLElement,
  x: number,
  y: number
): boolean {
  const rect = element.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const candidates = [
    { x, y },
    { x: x / scale, y: y / scale },
  ];
  return candidates.some(
    (point) =>
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom
  );
}

export async function fileFromHostPath(
  path: string,
  readBytes: (path: string) => Promise<Uint8Array>
): Promise<File> {
  const bytes = await readBytes(path);
  const name = hostPathFileName(path) || 'dropped-file';
  return new File([bytes], name, { type: mimeForHostPath(path) });
}
