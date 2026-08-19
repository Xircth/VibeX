import { fileNameFromPath } from './ToolCallTarget';

export type DirListEntry = {
  name: string;
  kind: 'file' | 'folder';
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(
  record: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function kindFromHint(
  name: string,
  hint?: string | null,
  flaggedDir?: boolean
): 'file' | 'folder' {
  const normalized = hint?.toLowerCase() ?? '';
  if (
    flaggedDir ||
    normalized === 'dir' ||
    normalized === 'directory' ||
    normalized === 'folder'
  ) {
    return 'folder';
  }
  if (normalized === 'file') return 'file';
  return /[\\/]$/.test(name) ? 'folder' : 'file';
}

export function parseDirectoryListing(value: unknown): DirListEntry[] {
  if (value == null) return [];

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return parseDirectoryListing(JSON.parse(trimmed));
      } catch {
        // Fall through to line parsing.
      }
    }
    return trimmed.split(/\r?\n/).flatMap((line) => {
      const cleaned = line.replace(/^[│├└─\s*|`-]+/, '').trim();
      if (!cleaned || cleaned === '.' || cleaned === '..') return [];
      const isDir = /[\\/]\s*$/.test(cleaned);
      return [
        {
          name: fileNameFromPath(cleaned.replace(/[\\/]+$/, '')),
          kind: isDir ? 'folder' : 'file',
        },
      ];
    });
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string') return parseDirectoryListing(item);
      const record = asRecord(item);
      if (!record) return [];
      const name = firstString(record, ['name', 'path', 'filename', 'file']);
      if (!name) return [];
      return [
        {
          name: fileNameFromPath(name),
          kind: kindFromHint(
            name,
            firstString(record, ['type', 'kind', 'entry_type']),
            record.is_dir === true || record.isDirectory === true
          ),
        },
      ];
    });
  }

  const record = asRecord(value);
  if (!record) return [];

  if (Array.isArray(record.directories) || Array.isArray(record.files)) {
    return [
      ...parseDirectoryListing(record.directories).map((entry) => ({
        ...entry,
        kind: 'folder' as const,
      })),
      ...parseDirectoryListing(record.files),
    ];
  }

  for (const key of [
    'entries',
    'children',
    'items',
    'listing',
    'files',
    'value',
    'content',
  ]) {
    if (key in record) {
      const nested = parseDirectoryListing(record[key]);
      if (nested.length > 0) return nested;
    }
  }

  return [];
}

export function listDirPath(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return typeof value === 'string' ? value : null;
  return (
    firstString(record, [
      'target_directory',
      'directory',
      'dir',
      'path',
      'target_file',
      'file_path',
    ]) ?? listDirPath(record.action)
  );
}
