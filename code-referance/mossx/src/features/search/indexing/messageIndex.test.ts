import { describe, expect, it } from "vitest";
import { buildWorkspaceMessageIndex, makeMessageSnippet } from "./messageIndex";

describe("messageIndex", () => {
  it("indexes only message items", () => {
    const indexed = buildWorkspaceMessageIndex(
      ["thread-1"],
      {
        "thread-1": [
          { id: "m1", kind: "message", role: "user", text: "hello world" },
          { id: "r1", kind: "reasoning", summary: "s", content: "c" },
        ],
      },
    );

    expect(indexed).toEqual([
      {
        messageId: "m1",
        threadId: "thread-1",
        text: "hello world",
      },
    ]);
  });

  it("creates a bounded snippet around the hit", () => {
    const snippet = makeMessageSnippet("abc def ghi jkl mno pqr", "ghi", 4);
    expect(snippet).toContain("ghi");
    expect(snippet.length).toBeLessThanOrEqual(20);
  });
});
