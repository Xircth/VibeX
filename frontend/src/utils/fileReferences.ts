export const FILE_REFERENCE_DRAG_MIME = 'application/x-vibe-file-reference';

export type FileReferenceKind = 'file' | 'directory';

export interface FileReferencePayload {
  fileName: string;
  relativePath: string;
  kind: FileReferenceKind;
}

export function serializeFileReferencePayload(
  payload: FileReferencePayload
): string {
  return JSON.stringify(payload);
}

export function parseFileReferencePayload(
  value: string | null | undefined
): FileReferencePayload | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<FileReferencePayload>;
    if (
      typeof parsed.fileName !== 'string' ||
      typeof parsed.relativePath !== 'string' ||
      (parsed.kind !== 'file' && parsed.kind !== 'directory')
    ) {
      return null;
    }

    return {
      fileName: parsed.fileName,
      relativePath: parsed.relativePath,
      kind: parsed.kind,
    };
  } catch {
    return null;
  }
}
