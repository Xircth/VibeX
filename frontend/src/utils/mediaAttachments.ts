export const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
]);

export const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'webm',
  'mov',
  'm4v',
  'avi',
  'mkv',
  'mpeg',
  'mpg',
]);

export function fileExtension(name: string): string {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot < 0 || dot === trimmed.length - 1) {
    return '';
  }
  return trimmed.slice(dot + 1).toLowerCase();
}

export function isImageExtension(extension: string): boolean {
  return IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

export function isVideoExtension(extension: string): boolean {
  return VIDEO_EXTENSIONS.has(extension.toLowerCase());
}

export function isImageFile(file: File): boolean {
  return (
    file.type.startsWith('image/') || isImageExtension(fileExtension(file.name))
  );
}

export function isVideoFile(file: File): boolean {
  return (
    file.type.startsWith('video/') || isVideoExtension(fileExtension(file.name))
  );
}

export function isAttachableMediaFile(file: File): boolean {
  return isImageFile(file) || isVideoFile(file);
}

export function isAttachableFile(file: File): boolean {
  return Boolean(file.name.trim() || file.type || file.size > 0);
}

export function mimeForMediaExtension(extension: string): string {
  switch (extension.toLowerCase()) {
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
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mov':
      return 'video/quicktime';
    case 'm4v':
      return 'video/x-m4v';
    case 'avi':
      return 'video/x-msvideo';
    case 'mkv':
      return 'video/x-matroska';
    case 'mpeg':
    case 'mpg':
      return 'video/mpeg';
    case 'pdf':
      return 'application/pdf';
    case 'txt':
      return 'text/plain';
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'json':
      return 'application/json';
    case 'csv':
      return 'text/csv';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'xml':
      return 'application/xml';
    case 'rtf':
      return 'application/rtf';
    case 'doc':
      return 'application/msword';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'ppt':
      return 'application/vnd.ms-powerpoint';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

export function mediaExtensionForMime(type: string): string {
  switch (type.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    case 'image/svg+xml':
      return 'svg';
    case 'video/mp4':
      return 'mp4';
    case 'video/webm':
      return 'webm';
    case 'video/quicktime':
      return 'mov';
    case 'video/x-m4v':
      return 'm4v';
    case 'video/x-msvideo':
      return 'avi';
    case 'video/x-matroska':
      return 'mkv';
    case 'video/mpeg':
      return 'mpeg';
    case 'application/pdf':
      return 'pdf';
    case 'text/plain':
      return 'txt';
    case 'text/markdown':
      return 'md';
    case 'application/json':
      return 'json';
    case 'text/csv':
      return 'csv';
    case 'text/html':
      return 'html';
    case 'application/msword':
      return 'doc';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    case 'application/vnd.ms-excel':
      return 'xls';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xlsx';
    case 'application/vnd.ms-powerpoint':
      return 'ppt';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return 'pptx';
    case 'application/zip':
      return 'zip';
    default:
      if (type.startsWith('video/')) return 'mp4';
      if (type.startsWith('image/')) return 'png';
      if (type.startsWith('text/')) return 'txt';
      return 'bin';
  }
}

export function fileNameForMediaUpload(file: File): string {
  const name = file.name.trim();
  const extension = fileExtension(name);
  if (name && extension) {
    return name;
  }
  const mimeExtension = file.type ? mediaExtensionForMime(file.type) : '';
  if (name) {
    return mimeExtension ? `${name}.${mimeExtension}` : name;
  }
  if (file.type.startsWith('video/')) {
    return `pasted-video.${mimeExtension || 'mp4'}`;
  }
  if (file.type.startsWith('image/')) {
    return `pasted-image.${mimeExtension || 'png'}`;
  }
  return `pasted-file.${mimeExtension || 'bin'}`;
}

export function prepareMediaFileForUpload(file: File): File {
  const name = fileNameForMediaUpload(file);
  if (name === file.name) return file;
  return new File([file], name, {
    type: file.type || mimeForMediaExtension(fileExtension(name)),
  });
}
