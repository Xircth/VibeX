import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  lspPositionToEditorLocation,
  lspPositionToOffset,
  offsetToLspPosition,
} from "./lspPosition";

describe("lspPosition", () => {
  it("converts offset to lsp position", () => {
    const doc = Text.of(["alpha", "beta"]);
    expect(offsetToLspPosition(doc, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToLspPosition(doc, 3)).toEqual({ line: 0, character: 3 });
    expect(offsetToLspPosition(doc, 6)).toEqual({ line: 1, character: 0 });
  });

  it("clamps out-of-range offset and converts back", () => {
    const doc = Text.of(["abc", "def"]);
    const end = offsetToLspPosition(doc, 10_000);
    expect(end).toEqual({ line: 1, character: 3 });
    expect(lspPositionToOffset(doc, end)).toBe(doc.length);
  });

  it("clamps lsp position when converting to offset", () => {
    const doc = Text.of(["abc", "de"]);
    expect(lspPositionToOffset(doc, { line: -1, character: -5 })).toBe(0);
    expect(lspPositionToOffset(doc, { line: 99, character: 99 })).toBe(doc.length);
  });

  it("converts lsp position to 1-based editor location", () => {
    expect(lspPositionToEditorLocation({ line: 0, character: 0 })).toEqual({
      line: 1,
      column: 1,
    });
    expect(lspPositionToEditorLocation({ line: 4, character: 9 })).toEqual({
      line: 5,
      column: 10,
    });
  });
});
