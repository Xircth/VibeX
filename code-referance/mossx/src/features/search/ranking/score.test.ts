import { describe, expect, it } from "vitest";
import type { SearchResult } from "../types";
import { compareSearchResults } from "./score";

describe("compareSearchResults", () => {
  it("uses recency boost when base score is equal", () => {
    const a: SearchResult = { id: "a", kind: "file", title: "A", score: 100 };
    const b: SearchResult = { id: "b", kind: "file", title: "B", score: 100 };
    const recency = { b: Date.now() };

    const sorted = [a, b].sort((left, right) => compareSearchResults(left, right, recency));
    expect(sorted[0]?.id).toBe("b");
  });
});
