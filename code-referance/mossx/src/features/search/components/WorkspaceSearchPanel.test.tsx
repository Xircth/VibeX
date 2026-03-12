// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn(async (...args: any[]) => {
  const command = args[0];
  if (command === "search_workspace_text") {
    return {
      files: [
        {
          path: "src/index.ts",
          match_count: 2,
          matches: [
            {
              line: 3,
              column: 15,
              end_column: 23,
              preview: "const codemoss = createApp();",
            },
          ],
        },
      ],
      file_count: 1,
      match_count: 2,
      limit_hit: false,
    };
  }
  return null;
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === "files.searchResultsSummary" && params) {
        return `${params.files} 个文件中有 ${params.matches} 个结果`;
      }
      return key;
    },
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => invokeMock(...args),
}));

let WorkspaceSearchPanel: typeof import("./WorkspaceSearchPanel").WorkspaceSearchPanel;

beforeAll(async () => {
  ({ WorkspaceSearchPanel } = await import("./WorkspaceSearchPanel"));
});

afterEach(() => {
  cleanup();
  invokeMock.mockClear();
});

describe("WorkspaceSearchPanel", () => {
  it("renders as an independent panel tab view", () => {
    render(
      <WorkspaceSearchPanel
        workspaceId="workspace-1"
        filePanelMode="search"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
      />,
    );

    expect(screen.getByRole("searchbox", { name: "files.filterPlaceholder" })).toBeTruthy();
  });

  it("runs workspace text search and opens a result at line and column", async () => {
    const onOpenFile = vi.fn();
    render(
      <WorkspaceSearchPanel
        workspaceId="workspace-1"
        filePanelMode="search"
        onFilePanelModeChange={() => undefined}
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "files.filterPlaceholder" }), {
      target: { value: "codemoss" },
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("search_workspace_text", {
        workspaceId: "workspace-1",
        query: "codemoss",
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
        includePattern: null,
        excludePattern: null,
      });
    });

    expect(screen.getByText("src/index.ts")).toBeTruthy();
    expect(screen.getByText(/const codemoss = createApp\(\);/)).toBeTruthy();

    fireEvent.click(screen.getByText(/const codemoss = createApp\(\);/));
    expect(onOpenFile).toHaveBeenCalledWith("src/index.ts", { line: 3, column: 15 });
  });

  it("shows include and exclude inputs when expanding search options", () => {
    render(
      <WorkspaceSearchPanel
        workspaceId="workspace-1"
        filePanelMode="search"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "files.searchDetails" }));
    expect(screen.getByLabelText("files.includePattern")).toBeTruthy();
    expect(screen.getByLabelText("files.excludePattern")).toBeTruthy();
  });
});
