const IMAGE_PREVIEW_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'avif',
  'bmp',
  'heic',
  'heif',
  'tif',
  'tiff',
  'ico',
]);

const PDF_PREVIEW_EXTENSIONS = new Set(['pdf']);

const DOCUMENT_PREVIEW_EXTENSIONS = new Set(['doc', 'docx']);

const BINARY_PREVIEW_EXTENSIONS = new Set([
  'icns',
  'zip',
  'gz',
  'tgz',
  '7z',
  'rar',
  'tar',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'webm',
  'wasm',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'class',
  'jar',
  'db',
  'sqlite',
]);

export type FilePreviewKind = 'text' | 'image' | 'pdf' | 'document' | 'binary';

function extensionFromPath(path?: string | null) {
  if (!path) {
    return '';
  }

  const normalized = path.replace(/\\/g, '/');
  const fileName = normalized.split('/').pop() ?? normalized;
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === fileName.length - 1) {
    return '';
  }

  return fileName.slice(dotIndex + 1).toLowerCase();
}

export function isImagePreviewPath(path?: string | null) {
  return IMAGE_PREVIEW_EXTENSIONS.has(extensionFromPath(path));
}

export function isBinaryPreviewPath(path?: string | null) {
  return BINARY_PREVIEW_EXTENSIONS.has(extensionFromPath(path));
}

export function isPdfPreviewPath(path?: string | null) {
  return PDF_PREVIEW_EXTENSIONS.has(extensionFromPath(path));
}

export function isDocumentPreviewPath(path?: string | null) {
  return DOCUMENT_PREVIEW_EXTENSIONS.has(extensionFromPath(path));
}

export function getFilePreviewKind(path?: string | null): FilePreviewKind {
  if (isImagePreviewPath(path)) {
    return 'image';
  }

  if (isPdfPreviewPath(path)) {
    return 'pdf';
  }

  if (isDocumentPreviewPath(path)) {
    return 'document';
  }

  if (isBinaryPreviewPath(path)) {
    return 'binary';
  }

  return 'text';
}

export function isBinaryContentError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';

  const normalized = message.toLowerCase();
  return (
    normalized.includes('binary file') ||
    normalized.includes('not valid utf-8') ||
    normalized.includes('valid utf-8')
  );
}
