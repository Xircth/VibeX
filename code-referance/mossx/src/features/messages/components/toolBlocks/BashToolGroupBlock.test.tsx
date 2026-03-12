// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationItem } from "../../../../types";
import { BashToolGroupBlock } from "./BashToolGroupBlock";

const makeToolItem = (
  id: string,
  command: string | string[],
  output: string,
  status: Extract<ConversationItem, { kind: "tool" }>["status"] = "completed",
  description = "",
): Extract<ConversationItem, { kind: "tool" }> => ({
  id,
  kind: "tool",
  toolType: "commandExecution",
  title: typeof command === "string" ? `Command: ${command}` : "Command",
  detail: JSON.stringify({ command, description }),
  status,
  output,
});

describe("BashToolGroupBlock", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders batch outputs in stacked lines when one item is expanded", () => {
    render(
      <BashToolGroupBlock
        items={[
          makeToolItem("bash-group-1", "npm run lint", "first line\nsecond line\nError: failed"),
          makeToolItem("bash-group-2", "npm run test", "ok"),
        ]}
      />,
    );

    fireEvent.click(screen.getByText("npm run lint"));

    const outputLines = document.querySelectorAll(".bash-output-line");
    expect(outputLines.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("first line")).toBeTruthy();
    expect(screen.getByText("second line")).toBeTruthy();
    const errorLine = screen.getByText("Error: failed");
    expect(errorLine.className).toContain("bash-output-line-error");
  });

  it("prefers description and renders row status indicators", () => {
    render(
      <BashToolGroupBlock
        items={[
          makeToolItem(
            "bash-group-3",
            ["git", "status", "--short"],
            "ok",
            "completed",
            "Show working tree status",
          ),
          makeToolItem(
            "bash-group-4",
            ["git", "diff", "--cached"],
            "ok",
            "completed",
            "Show staged and unstaged changes",
          ),
        ]}
      />,
    );

    expect(screen.getByText("Show working tree status")).toBeTruthy();
    expect(screen.getByText("Show staged and unstaged changes")).toBeTruthy();
    expect(document.querySelectorAll(".bash-item-status")).toHaveLength(2);

    const allCompletedNode = screen.queryByText("全部完成") ?? screen.queryByText("tools.bashGroupAllCompleted");
    expect(allCompletedNode).toBeTruthy();
  });
});
