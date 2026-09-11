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

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);

const HTML_EXTENSIONS = new Set(['html', 'htm']);

const BINARY_PREVIEW_EXTENSIONS = new Set([
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
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

export type FilePreviewKind = 'text' | 'image' | 'pdf' | 'binary';

/**
 * A file that has both a rendered and a source view in the preview panel.
 * Files without a preview form are only ever shown as text.
 */
export type FilePreviewForm = 'markdown' | 'html';

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

export function getFilePreviewKind(path?: string | null): FilePreviewKind {
  if (isImagePreviewPath(path)) {
    return 'image';
  }

  if (isPdfPreviewPath(path)) {
    return 'pdf';
  }

  if (isBinaryPreviewPath(path)) {
    return 'binary';
  }

  return 'text';
}

export function getFilePreviewForm(
  path?: string | null
): FilePreviewForm | null {
  const extension = extensionFromPath(path);

  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return 'markdown';
  }

  if (HTML_EXTENSIONS.has(extension)) {
    return 'html';
  }

  return null;
}

/**
 * Which view a file opens in the first time it is previewed. Markdown opens as
 * source because a rendered document hides the text an edit acts on; HTML opens
 * rendered because its source is markup the reader rarely wants to see.
 */
export function defaultRenderedPreview(form: FilePreviewForm): boolean {
  return form === 'html';
}

/**
 * Extensions worth pushing in front of the user unprompted. Deliberately
 * narrower than `IMAGE_PREVIEW_EXTENSIONS`: a screenshot or a photo appearing
 * in the tree is not a reason to open a tab, but a page or a drawing the user
 * can look at without editing is.
 */
const AUTO_PREVIEW_EXTENSIONS = new Set(['html', 'htm', 'svg']);

/** Whether a newly created file should open its preview on its own. */
export function isAutoPreviewPath(path?: string | null): boolean {
  return AUTO_PREVIEW_EXTENSIONS.has(extensionFromPath(path));
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
