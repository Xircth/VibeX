// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationItem } from "../../../../types";
import { normalizeItem } from "../../../../utils/threadItems";
import { EditToolBlock } from "./EditToolBlock";

function createEditItem(
  id: string,
  detail: Record<string, unknown>,
  output?: string,
): Extract<ConversationItem, { kind: "tool" }> {
  return {
    id,
    kind: "tool",
    toolType: "edit",
    title: "Tool: edit",
    detail: JSON.stringify(detail),
    output,
    status: "completed",
  };
}

describe("EditToolBlock", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders structured diff preview when old/new strings are provided", () => {
    const item = createEditItem(
      "tool-1",
      {
        file_path: "src/release.yml",
        old_string: "line-a\nline-b",
        new_string: "line-a\nline-c",
      },
      "raw output should be hidden",
    );

    render(<EditToolBlock item={item}/>);

    fireEvent.click(screen.getByText("tools.editFile"));

    expect(screen.getByText("line-b")).toBeTruthy();
    expect(screen.getByText("line-c")).toBeTruthy();
    expect(screen.queryByText("raw output should be hidden")).toBeNull();
  });

  it("falls back to output text when structured diff is unavailable", () => {
    const item = createEditItem(
      "tool-2",
      {
        file_path: "src/release.yml",
      },
      "tool output fallback",
    );

    render(<EditToolBlock item={item}/>);

    fireEvent.click(screen.getByText("tools.editFile"));

    expect(screen.getByText("tool output fallback")).toBeTruthy();
  });

  it("supports nested input with camelCase fields", () => {
    const item = createEditItem("tool-3", {
      input: {
        filePath: "src/release.yml",
        oldString: "old-line",
        newString: "new-line",
      },
    });

    render(<EditToolBlock item={item}/>);

    expect(screen.getByText("release.yml")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
  });

  it("renders file and diff after normalizeItem for long Edit detail", () => {
    const oldString = Array.from({ length: 180 }, (_, index) => `old-${index}`).join("\n");
    const newString = Array.from({ length: 180 }, (_, index) => `new-${index}`).join("\n");
    const raw: ConversationItem = {
      id: "tool-4",
      kind: "tool",
      toolType: "Edit",
      title: "Tool: Edit",
      status: "completed",
      detail: JSON.stringify({
        replace_all: false,
        file_path: "/Users/zhukunpeng/Desktop/codemoss/.github/workflows/release.yml",
        old_string: oldString,
        new_string: newString,
      }),
      output:
        "The file /Users/zhukunpeng/Desktop/codemoss/.github/workflows/release.yml has been updated.",
    };
    const normalized = normalizeItem(raw);
    expect(normalized.kind).toBe("tool");
    if (normalized.kind !== "tool") {
      throw new Error("expected normalized tool item");
    }

    render(<EditToolBlock item={normalized}/>);

    expect(screen.getByText("release.yml")).toBeTruthy();
    expect(screen.getByText("+180")).toBeTruthy();
    expect(screen.getByText("-180")).toBeTruthy();
    fireEvent.click(screen.getByText("tools.editFile"));
    expect(screen.queryByText("The file /Users/zhukunpeng/Desktop/codemoss/.github/workflows/release.yml has been updated.")).toBeNull();
    expect(screen.getByText("old-0")).toBeTruthy();
    expect(screen.getByText("new-0")).toBeTruthy();
  });
});
