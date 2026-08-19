const URL_PATTERN = /https?:\/\/[^\s)<>"']+/gi;

export type ToolHitItem = {
  path: string | null;
  url: string | null;
  line: string | null;
  text: string;
  directory?: boolean;
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

export function looksLikeDirectoryPath(path: string): boolean {
  return /[\\/]$/.test(path);
}

export function looksLikeHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function fileHitFromLine(line: string): ToolHitItem | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const url = trimmed.match(URL_PATTERN)?.[0] ?? null;
  if (url) {
    const title = trimmed
      .replace(url, '')
      .replace(/^[-\d.)\s]+/, '')
      .trim();
    return { path: null, url, line: null, text: title || url };
  }

  const match = trimmed.match(/^(.*):(\d+):\s?(.*)$/);
  if (match) {
    return {
      path: match[1],
      url: null,
      line: match[2],
      text: match[3],
    };
  }

  return { path: null, url: null, line: null, text: trimmed };
}

function hitsFromString(value: string): ToolHitItem[] {
  return value
    .split(/\r?\n/)
    .map((line) => fileHitFromLine(line))
    .filter((item): item is ToolHitItem => item != null)
    .filter((item) => item.url || item.path || item.text);
}

function hitFromRecord(record: Record<string, unknown>): ToolHitItem | null {
  const url = firstString(record, ['url', 'uri', 'href', 'link']);
  const path = firstString(record, [
    'path',
    'file',
    'file_path',
    'target_file',
    'filename',
  ]);
  const line = [record.line, record.line_number, record.lineNumber].find(
    (field) => typeof field === 'string' || typeof field === 'number'
  );
  const text =
    firstString(record, [
      'title',
      'text',
      'content',
      'match',
      'preview',
      'snippet',
      'description',
    ]) ?? '';

  if (!url && !path && !text) return null;
  return {
    path: path && !looksLikeHttpUrl(path) ? path : null,
    url: url && looksLikeHttpUrl(url) ? url : null,
    line: line != null ? String(line) : null,
    text,
    directory: path ? looksLikeDirectoryPath(path) : false,
  };
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function sourceHits(value: unknown): ToolHitItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') {
      return looksLikeHttpUrl(item)
        ? [{ path: null, url: item, line: null, text: item }]
        : [];
    }
    const record = asRecord(item);
    if (!record) return [];
    const url = firstString(record, ['url', 'uri', 'href', 'link']);
    if (!url || !looksLikeHttpUrl(url)) return [];
    return [
      {
        path: null,
        url,
        line: null,
        text: firstString(record, ['title', 'name', 'text']) ?? url,
        directory: false,
      },
    ];
  });
}

export function parseSearchQuery(value: unknown): string | null {
  if (typeof value === 'string') {
    const parsed = tryParseJson(value);
    return parsed != null ? parseSearchQuery(parsed) : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  return (
    firstString(record, ['query', 'pattern', 'q', 'glob', 'regex']) ??
    parseSearchQuery(record.action) ??
    parseSearchQuery(record.input)
  );
}

export function parseToolHitItems(value: unknown): ToolHitItem[] {
  if (value == null) return [];
  if (typeof value === 'string') {
    const parsed = tryParseJson(value);
    if (parsed != null) return parseToolHitItems(parsed);
    const urls = [...new Set(value.match(URL_PATTERN) ?? [])];
    if (urls.length > 1 || (urls.length === 1 && value.includes('"url"'))) {
      return urls.map((url) => ({
        path: null,
        url,
        line: null,
        text: url,
        directory: false,
      }));
    }
    return hitsFromString(value);
  }
  if (Array.isArray(value)) {
    const asSources = sourceHits(value);
    if (asSources.length > 0) return asSources;
    return value.flatMap((item) => parseToolHitItems(item));
  }

  const record = asRecord(value);
  if (!record) return [];

  const nestedSources = sourceHits(
    record.sources ?? asRecord(record.action)?.sources
  );
  if (nestedSources.length > 0) return nestedSources;

  for (const key of [
    'results',
    'items',
    'matches',
    'hits',
    'value',
    'action',
  ]) {
    if (key in record) {
      const nested = parseToolHitItems(record[key]);
      if (nested.length > 0) return nested;
    }
  }

  const single = hitFromRecord(record);
  return single ? [single] : [];
}

export function collectHttpUrls(
  value: unknown,
  found = new Set<string>()
): string[] {
  if (typeof value === 'string') {
    for (const match of value.match(URL_PATTERN) ?? []) found.add(match);
    return [...found];
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectHttpUrls(item, found));
    return [...found];
  }
  const record = asRecord(value);
  if (!record) return [...found];
  Object.values(record).forEach((item) => collectHttpUrls(item, found));
  return [...found];
}
