import type { CommandExitStatus, JsonValue } from 'shared/types';

export type ArtifactFact = {
  key: string;
  value: string;
};

const SEARCH_SKIP_KEYS = new Set(['query', 'q', 'pattern', 'search', 'text']);

export function splitCodeLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export function formatFactValue(value: JsonValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value == null) return '';
  if (Array.isArray(value)) {
    if (
      value.every(
        (item) =>
          item == null ||
          typeof item === 'string' ||
          typeof item === 'number' ||
          typeof item === 'boolean'
      )
    ) {
      return value
        .filter((item) => item != null && item !== '')
        .map((item) => String(item))
        .join(', ');
    }
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

export function jsonToFacts(
  value: JsonValue | null | undefined,
  options?: { skipKeys?: Iterable<string> }
): ArtifactFact[] {
  if (value == null || value === '') return [];
  if (typeof value !== 'object') {
    return [{ key: '', value: formatFactValue(value) }];
  }

  const skip = new Set(options?.skipKeys);
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      if (item == null || item === '') return [];
      return [{ key: String(index + 1), value: formatFactValue(item) }];
    });
  }

  return Object.entries(value).flatMap(([key, item]) => {
    if (skip.has(key) || item == null || item === '') return [];
    return [{ key, value: formatFactValue(item) }];
  });
}

export function searchArgumentFacts(
  value: JsonValue | null | undefined,
  query?: string
): ArtifactFact[] {
  return jsonToFacts(value, { skipKeys: SEARCH_SKIP_KEYS }).filter((fact) => {
    if (!query) return true;
    return fact.value !== query;
  });
}

export function commandExitCode(
  exitStatus: CommandExitStatus | null | undefined
): { code: number | null; ok: boolean | null } {
  if (!exitStatus) return { code: null, ok: null };
  if (exitStatus.type === 'exit_code') {
    return { code: exitStatus.code, ok: exitStatus.code === 0 };
  }
  return { code: exitStatus.success ? 0 : 1, ok: exitStatus.success };
}

export function stringList(value: JsonValue | null | undefined): string[] {
  if (typeof value === 'string' && value.trim()) return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    typeof item === 'string' && item.trim() ? [item] : []
  );
}
