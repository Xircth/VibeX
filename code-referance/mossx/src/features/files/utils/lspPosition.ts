import type { Text } from "@codemirror/state";

export type LspPosition = {
  line: number;
  character: number;
};

function clampOffset(doc: Text, offset: number) {
  const docLength = doc.length;
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.min(Math.max(Math.floor(offset), 0), docLength);
}

export function offsetToLspPosition(doc: Text, offset: number): LspPosition {
  const safeOffset = clampOffset(doc, offset);
  const lineInfo = doc.lineAt(safeOffset);
  return {
    line: Math.max(0, lineInfo.number - 1),
    character: Math.max(0, safeOffset - lineInfo.from),
  };
}

export function lspPositionToOffset(doc: Text, position: LspPosition): number {
  const lineNumber = Math.min(
    Math.max(Math.floor(position.line) + 1, 1),
    doc.lines,
  );
  const lineInfo = doc.line(lineNumber);
  const safeCharacter = Math.min(
    Math.max(Math.floor(position.character), 0),
    lineInfo.length,
  );
  return lineInfo.from + safeCharacter;
}

export function lspPositionToEditorLocation(position: LspPosition) {
  return {
    line: Math.max(1, Math.floor(position.line) + 1),
    column: Math.max(1, Math.floor(position.character) + 1),
  };
}
