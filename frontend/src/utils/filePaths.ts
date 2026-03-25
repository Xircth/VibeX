export function isAbsoluteFilePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/');
}

export function normalizeFilePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function resolveFilePathFromRoot(
  filePath: string,
  rootPath: string | null | undefined
): string {
  if (isAbsoluteFilePath(filePath) || !rootPath) {
    return filePath;
  }

  const usesWindowsSeparator = rootPath.includes('\\');
  const separator = usesWindowsSeparator ? '\\' : '/';
  const base = rootPath.replace(/[\\/]+$/, '');
  const normalizedRelative = usesWindowsSeparator
    ? filePath.replaceAll('/', '\\')
    : filePath;

  return `${base}${separator}${normalizedRelative}`;
}

export function deriveRelativeFilePath(
  filePath: string,
  rootPath: string | null | undefined
): string | null {
  if (!rootPath) {
    return null;
  }

  const normalizedFilePath = normalizeFilePath(filePath);
  const normalizedRootPath = normalizeFilePath(rootPath);

  if (normalizedFilePath === normalizedRootPath) {
    return '.';
  }

  if (!normalizedFilePath.startsWith(`${normalizedRootPath}/`)) {
    return null;
  }

  return normalizedFilePath.slice(normalizedRootPath.length + 1);
}
