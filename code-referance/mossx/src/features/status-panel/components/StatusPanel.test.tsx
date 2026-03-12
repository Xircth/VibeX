// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationItem, TurnPlan } from "../../../types";
import { StatusPanel } from "./StatusPanel";

const editToolItem: Extract<ConversationItem, { kind: "tool" }> = {
  id: "tool-edit-1",
  kind: "tool",
  toolType: "edit",
  title: "Edit file",
  detail: '{"path":"README.md"}',
  status: "completed",
  changes: [
    { path: "README.md", kind: "modify" },
    { path: "docs/EXECUTION_PLAN.md", kind: "modify" },
  ],
};

const taskToolItem: Extract<ConversationItem, { kind: "tool" }> = {
  id: "tool-task-1",
  kind: "tool",
  toolType: "task",
  title: "Tool: task",
  detail: '{"description":"review plan"}',
  status: "completed",
  output: "done",
};

const planSample: TurnPlan = {
  turnId: "turn-1",
  explanation: "plan",
  steps: [
    { step: "step 1", status: "completed" },
    { step: "step 2", status: "pending" },
  ],
};

const inProgressPlan: TurnPlan = {
  turnId: "turn-2",
  explanation: "plan",
  steps: [{ step: "step in progress", status: "inProgress" }],
};

describe("StatusPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens diff when clicking file in edits popover and closes popover", () => {
    const onOpenDiffPath = vi.fn();
    render(
      <StatusPanel
        items={[editToolItem]}
        isProcessing={false}
        onOpenDiffPath={onOpenDiffPath}
      />,
    );

    fireEvent.click(screen.getByText("statusPanel.tabEdits"));
    fireEvent.click(screen.getByText("README.md"));

    expect(onOpenDiffPath).toHaveBeenCalledWith("README.md");
    expect(screen.queryByText("docs/EXECUTION_PLAN.md")).toBeNull();
  });

  it("shows plan tab with progress summary", () => {
    render(
      <StatusPanel
        items={[editToolItem]}
        isProcessing={false}
        plan={planSample}
        isPlanMode
      />,
    );

    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("closes opened popover by Escape key", () => {
    render(
      <StatusPanel
        items={[editToolItem]}
        isProcessing={false}
      />,
    );

    fireEvent.click(screen.getByText("statusPanel.tabEdits"));
    expect(screen.getByText("README.md")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("README.md")).toBeNull();
  });

  it("does not render when expanded is false", () => {
    const { container } = render(
      <StatusPanel
        items={[editToolItem]}
        isProcessing={false}
        expanded={false}
      />,
    );
    expect(container.querySelector(".sp-root")).toBeNull();
  });

  it("shows legacy tabs when expanded even without status data", () => {
    render(
      <StatusPanel
        items={[]}
        isProcessing={false}
      />,
    );
    expect(screen.getByText("statusPanel.tabTodos")).toBeTruthy();
    expect(screen.getByText("statusPanel.tabSubagents")).toBeTruthy();
    expect(screen.getByText("statusPanel.tabEdits")).toBeTruthy();
  });

  it("shows legacy tabs and plan together without half split", () => {
    render(
      <StatusPanel
        items={[editToolItem]}
        isProcessing={false}
        plan={planSample}
        isPlanMode
      />,
    );
    expect(screen.getByText("statusPanel.tabTodos")).toBeTruthy();
    expect(screen.getByText("statusPanel.tabSubagents")).toBeTruthy();
    const editTab = screen.getByText("statusPanel.tabEdits").closest("button");
    const planTab = screen.getByText("Plan").closest("button");
    expect(editTab?.className).not.toContain("sp-tab-half");
    expect(planTab?.className).not.toContain("sp-tab-half");

    fireEvent.click(screen.getByText("statusPanel.tabEdits"));
    expect(screen.getByText("README.md")).toBeTruthy();
    fireEvent.click(screen.getByText("statusPanel.tabEdits"));
    expect(screen.queryByText("README.md")).toBeNull();
  });

  it("shows codex activity tabs without inline plan tab", () => {
    render(
      <StatusPanel
        items={[editToolItem, taskToolItem]}
        isProcessing={false}
        plan={planSample}
        isPlanMode
        isCodexEngine
      />,
    );

    expect(screen.getByText("statusPanel.tabTodos")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByText("statusPanel.tabAgents")).toBeTruthy();
    expect(screen.getByText("statusPanel.tabEdits")).toBeTruthy();
    expect(screen.queryByText("Plan")).toBeNull();
    const allTabs = document.querySelectorAll(".sp-tab-half");
    expect(allTabs.length).toBe(0);
  });

  it("keeps codex status panel visible even when only plan data exists", () => {
    render(
      <StatusPanel
        items={[]}
        isProcessing={false}
        plan={planSample}
        isPlanMode={false}
        isCodexEngine
      />,
    );

    expect(screen.getByText("statusPanel.tabTodos")).toBeTruthy();
    expect(screen.getByText("statusPanel.tabAgents")).toBeTruthy();
    expect(screen.getByText("statusPanel.tabEdits")).toBeTruthy();
    expect(screen.queryByText("Plan")).toBeNull();
  });

  it("renders plan steps inside codex todo tab", () => {
    render(
      <StatusPanel
        items={[]}
        isProcessing={false}
        plan={planSample}
        isPlanMode={false}
        isCodexEngine
      />,
    );

    fireEvent.click(screen.getByText("statusPanel.tabTodos"));
    expect(screen.getByText("step 1")).toBeTruthy();
    expect(screen.getByText("step 2")).toBeTruthy();
  });

  it("shows zero-state codex tabs when there is no status data", () => {
    render(
      <StatusPanel
        items={[]}
        isProcessing={false}
        isCodexEngine
      />,
    );

    expect(screen.getByText("statusPanel.tabTodos")).toBeTruthy();
    expect(screen.getAllByText("0/0").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("statusPanel.tabAgents")).toBeTruthy();
    expect(screen.getByText("statusPanel.tabEdits")).toBeTruthy();
  });

  it("downgrades codex in-progress plan steps when thread is idle", () => {
    const { container } = render(
      <StatusPanel
        items={[]}
        isProcessing={false}
        plan={inProgressPlan}
        isPlanMode={false}
        isCodexEngine
      />,
    );

    fireEvent.click(screen.getByText("statusPanel.tabTodos"));
    expect(screen.getByText("step in progress")).toBeTruthy();
    expect(container.querySelector(".sp-todo-in_progress")).toBeNull();
    expect(container.querySelector(".sp-todo-pending")).toBeTruthy();
  });
});
