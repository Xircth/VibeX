// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationItem } from "../../../../types";
import { EditToolGroupBlock } from "./EditToolGroupBlock";

function createEditToolItem(
  id: string,
  detail: Record<string, unknown>,
): Extract<ConversationItem, { kind: "tool" }> {
  return {
    id,
    kind: "tool",
    toolType: "edit",
    title: "Tool: edit",
    detail: JSON.stringify(detail),
    status: "completed",
  };
}

describe("EditToolGroupBlock", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders batch title, file list and aggregated diff", () => {
    render(
      <EditToolGroupBlock
        items={[
          createEditToolItem("tool-1", {
            file_path: "src/release.yml",
            old_string: "line1\nline2",
            new_string: "line1\nline2\nline3",
          }),
          createEditToolItem("tool-2", {
            file_path: "src/app.ts",
            old_string: "a\nb\nc",
            new_string: "a\nc",
          }),
        ]}
      />,
    );

    expect(screen.getByText("tools.batchEditFile")).toBeTruthy();
    expect(screen.getByText("(2)")).toBeTruthy();
    expect(screen.getByText("release.yml")).toBeTruthy();
    expect(screen.getByText("app.ts")).toBeTruthy();
    expect(screen.getAllByText("+1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("-1").length).toBeGreaterThan(0);
  });

  it("opens git diff when clicking edited file name", () => {
    const onOpenDiffPath = vi.fn();
    render(
      <EditToolGroupBlock
        items={[
          createEditToolItem("tool-3", {
            file_path: "src/App.tsx",
            old_string: "old",
            new_string: "new",
          }),
        ]}
        onOpenDiffPath={onOpenDiffPath}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "App.tsx" }));
    expect(onOpenDiffPath).toHaveBeenCalledWith("src/App.tsx");
  });

  it("supports nested input and camelCase edit fields", () => {
    render(
      <EditToolGroupBlock
        items={[
          createEditToolItem("tool-5", {
            input: {
              filePath: "src/release.yml",
              oldString: "foo",
              newString: "bar",
            },
          }),
          createEditToolItem("tool-6", {
            arguments: {
              targetFile: "src/app.ts",
              oldString: "line-1",
              newString: "line-2",
            },
          }),
        ]}
      />,
    );

    expect(screen.getByText("release.yml")).toBeTruthy();
    expect(screen.getByText("app.ts")).toBeTruthy();
    expect(screen.getAllByText("+1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("-1").length).toBeGreaterThan(0);
  });

  it("returns null when all entries miss file path", () => {
    const { container } = render(
      <EditToolGroupBlock
        items={[
          createEditToolItem("tool-4", {
            old_string: "a",
            new_string: "b",
          }),
        ]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
