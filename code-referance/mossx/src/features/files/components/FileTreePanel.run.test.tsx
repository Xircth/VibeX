// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenAppTarget } from "../../../types";

const menuPopupMock = vi.fn(async () => undefined);
const menuNewMock = vi.fn(async ({ items }: { items: any[] }) => ({
  append: vi.fn(async () => undefined),
  popup: menuPopupMock,
  close: vi.fn(async () => undefined),
  items,
}));
const menuItemNewMock = vi.fn(async (options: any) => options);
const revealItemInDirMock = vi.fn(async () => undefined);

const invokeMock = vi.fn(async (...args: any[]) => {
  const command = args[0];
  if (command === "list_workspace_directory_children") {
    return {
      files: [] as string[],
      directories: [] as string[],
      gitignored_files: [] as string[],
      gitignored_directories: [] as string[],
    };
  }
  if (command === "read_workspace_file") {
    return { content: "", truncated: false };
  }
  if (command === "search_workspace_text") {
    return {
      files: [],
      file_count: 0,
      match_count: 0,
      limit_hit: false,
    };
  }
  return null;
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (value: string) => value,
  invoke: (...args: any[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/menu", () => ({
  Menu: {
    new: menuNewMock,
  },
  MenuItem: {
    new: menuItemNewMock,
  },
}));

vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalPosition: class {},
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    scaleFactor: vi.fn(async () => 1),
  })),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: revealItemInDirMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(async () => true),
}));

let FileTreePanel: typeof import("./FileTreePanel").FileTreePanel;

beforeAll(async () => {
  ({ FileTreePanel } = await import("./FileTreePanel"));
});

afterEach(() => {
  cleanup();
  invokeMock.mockClear();
  menuNewMock.mockClear();
  menuItemNewMock.mockClear();
  menuPopupMock.mockClear();
  revealItemInDirMock.mockClear();
});

describe("FileTreePanel run action isolation", () => {
  it("renders a single workspace root node and keeps it expanded by default", () => {
    const { container } = render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={["src/index.ts", "README.md"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    expect(screen.getByRole("button", { name: /workspace/ })).toBeTruthy();
    expect(container.querySelectorAll(".file-tree-row.is-root")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /src/ })).toBeTruthy();
  });

  it("restores child expansion state after collapsing and re-expanding workspace root", () => {
    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={["src/index.ts"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /src/ }));
    expect(screen.getByText("index.ts")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /workspace/ }));
    expect(screen.queryByText("index.ts")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /workspace/ }));
    expect(screen.getByText("index.ts")).toBeTruthy();
  });

  it("places workspace root on its own row", () => {
    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={["README.md"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        onToggleRuntimeConsole={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    const rootButton = screen.getByRole("button", { name: /workspace/ });
    const rootRow = rootButton.closest(".file-tree-root-row");
    expect(rootRow).toBeTruthy();
    expect(rootRow?.querySelectorAll(".file-tree-row.is-root")).toHaveLength(1);
  });

  it("keeps opened-file contract when running non-open action from root context menu", async () => {
    const onOpenFile = vi.fn();
    const writeTextMock = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeTextMock },
    });

    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={["README.md"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={onOpenFile}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace/ }));
    await waitFor(() => {
      expect(menuItemNewMock).toHaveBeenCalled();
      expect(menuNewMock).toHaveBeenCalled();
      expect(menuPopupMock).toHaveBeenCalled();
    });

    const copyPathItem = menuItemNewMock.mock.calls
      .map((call) => call[0])
      .find((item) => item.text === "files.copyPath");
    expect(copyPathItem).toBeTruthy();
    await copyPathItem.action();
    expect(writeTextMock).toHaveBeenCalledWith("/tmp/workspace/");
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("opens file preview read flow when onOpenFile handler is not provided", async () => {
    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={["README.md"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("read_workspace_file", {
        workspaceId: "workspace-1",
        path: "README.md",
      });
    });
  });

  it("keeps sticky-top and scroll-list containers separated in DOM structure", () => {
    const { container } = render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={["README.md"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    const topZone = container.querySelector(".file-tree-top-zone");
    const listZone = container.querySelector(".file-tree-list");
    expect(topZone).toBeTruthy();
    expect(listZone).toBeTruthy();
    expect(topZone?.contains(listZone as Node)).toBe(false);
  });

  it("renders empty directories from workspace directory snapshot", () => {
    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={["README.md"]}
        directories={["empty-dir"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    expect(screen.getByText("empty-dir")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  it("renders single-child empty directory chains in a.b.c style", () => {
    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={[]}
        directories={["a/b/c"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    expect(screen.getByText("a.b.c")).toBeTruthy();
  });

  it("does not render run icon button when handler is absent", () => {
    const openTargets: OpenAppTarget[] = [];

    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={[]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={() => undefined}
        openTargets={openTargets}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    expect(screen.queryByRole("button", { name: "files.openRunConsole" })).toBeNull();
  });

  it("keeps file open interactions working", () => {
    const onOpenFile = vi.fn();
    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={["src/index.ts", "README.md"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={onOpenFile}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    expect(onOpenFile).toHaveBeenCalledWith("README.md");
  });

  it("clicking folder row toggles children without opening file", () => {
    const onOpenFile = vi.fn();
    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={["src/index.ts"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={onOpenFile}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    expect(screen.queryByText("index.ts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /src/ }));
    expect(screen.getByText("index.ts")).toBeTruthy();
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "list_workspace_directory_children",
      expect.any(Object),
    );
  });

  it("loads special directory children lazily when expanded", async () => {
    invokeMock.mockImplementation(async (...args: any[]) => {
      const command = args[0];
      if (command === "list_workspace_directory_children") {
        return {
          files: ["node_modules/package.json"],
          directories: [] as string[],
          gitignored_files: [] as string[],
          gitignored_directories: [] as string[],
        };
      }
      return null;
    });

    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={[]}
        directories={["node_modules"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /node_modules/ }));
    expect(await screen.findByText("package.json")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("list_workspace_directory_children", {
      workspaceId: "workspace-1",
      path: "node_modules",
    });
  });

  it("loads nested directories lazily under special directory", async () => {
    invokeMock.mockImplementation(async (...args: any[]) => {
      const command = args[0];
      const payload = args[1];
      if (command !== "list_workspace_directory_children") {
        return null;
      }
      if (payload.path === "node_modules") {
        return {
          files: [] as string[],
          directories: ["node_modules/@babel"],
          gitignored_files: [] as string[],
          gitignored_directories: [] as string[],
        };
      }
      if (payload.path === "node_modules/@babel") {
        return {
          files: [] as string[],
          directories: ["node_modules/@babel/core"],
          gitignored_files: [] as string[],
          gitignored_directories: [] as string[],
        };
      }
      if (payload.path === "node_modules/@babel/core") {
        return {
          files: ["node_modules/@babel/core/index.js"],
          directories: [] as string[],
          gitignored_files: [] as string[],
          gitignored_directories: [] as string[],
        };
      }
      return {
        files: [] as string[],
        directories: [] as string[],
        gitignored_files: [] as string[],
        gitignored_directories: [] as string[],
      };
    });

    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={[]}
        directories={["node_modules"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /node_modules/ }));
    expect(await screen.findByRole("button", { name: /@babel/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /@babel/ }));
    expect(await screen.findByRole("button", { name: /core/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /core/ }));
    expect(await screen.findByText("index.js")).toBeTruthy();

    expect(invokeMock).toHaveBeenCalledWith("list_workspace_directory_children", {
      workspaceId: "workspace-1",
      path: "node_modules",
    });
    expect(invokeMock).toHaveBeenCalledWith("list_workspace_directory_children", {
      workspaceId: "workspace-1",
      path: "node_modules/@babel",
    });
    expect(invokeMock).toHaveBeenCalledWith("list_workspace_directory_children", {
      workspaceId: "workspace-1",
      path: "node_modules/@babel/core",
    });
  });

  it("shows root action buttons and trashes selected node from root row", async () => {
    const onRefreshFiles = vi.fn();

    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={["README.md"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        onRefreshFiles={onRefreshFiles}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    const deleteButton = screen.getByRole("button", { name: "files.deleteItem" }) as HTMLButtonElement;
    expect(screen.getByRole("button", { name: "files.newFile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "files.newFolder" })).toBeTruthy();
    expect(deleteButton).toBeTruthy();
    expect(deleteButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    expect(deleteButton.disabled).toBe(false);
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("trash_workspace_item", {
        workspaceId: "workspace-1",
        path: "README.md",
      });
    });
    expect(onRefreshFiles).toHaveBeenCalledTimes(1);
  });

  it("creates new folder from root action", async () => {
    const onRefreshFiles = vi.fn();

    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={["README.md"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        onRefreshFiles={onRefreshFiles}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "files.newFolder" }));
    const folderInput = screen.getByPlaceholderText("files.newFolderNamePlaceholder");
    fireEvent.change(folderInput, { target: { value: "docs" } });
    fireEvent.keyDown(folderInput, { key: "Enter" });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("create_workspace_directory", {
        workspaceId: "workspace-1",
        path: "docs",
      });
    });
    expect(onRefreshFiles).toHaveBeenCalledTimes(1);
  });

  it("creates new folder under selected folder from root action", async () => {
    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={["src/index.ts"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /src/ }));
    fireEvent.click(screen.getByRole("button", { name: "files.newFolder" }));
    const folderInput = screen.getByPlaceholderText("files.newFolderNamePlaceholder");
    fireEvent.change(folderInput, { target: { value: "docs" } });
    fireEvent.keyDown(folderInput, { key: "Enter" });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("create_workspace_directory", {
        workspaceId: "workspace-1",
        path: "src/docs",
      });
    });
  });

  it("creates new file under selected file parent from root action", async () => {
    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={["src/index.ts"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /src/ }));
    fireEvent.click(screen.getByRole("button", { name: "index.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "files.newFile" }));
    const fileInput = screen.getByPlaceholderText("files.newFileNamePlaceholder");
    fireEvent.change(fileInput, { target: { value: "utils.ts" } });
    fireEvent.keyDown(fileInput, { key: "Enter" });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("write_workspace_file", {
        workspaceId: "workspace-1",
        path: "src/utils.ts",
        content: "",
      });
    });
  });

  it("shows retry action when special directory lazy load fails", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({
        files: ["node_modules/package-lock.json"],
        directories: [] as string[],
        gitignored_files: [] as string[],
        gitignored_directories: [] as string[],
      });

    render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath="/tmp/workspace"
        files={[]}
        directories={["node_modules"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={() => undefined}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /node_modules/ }));
    expect(await screen.findByRole("button", { name: "加载失败，点击重试" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "加载失败，点击重试" }));
    await waitFor(() => {
      expect(screen.getByText("package-lock.json")).toBeTruthy();
    });
  });

  it("mentions file using Windows-style absolute path when workspace path uses backslashes", () => {
    const onInsertText = vi.fn();

    const { container } = render(
      <FileTreePanel
        workspaceId="workspace-1"
        workspacePath={"C:\\workspace\\demo"}
        files={["index.ts"]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={() => undefined}
        onOpenFile={() => undefined}
        onInsertText={onInsertText}
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={() => undefined}
        gitStatusFiles={[]}
        gitignoredFiles={new Set<string>()}
      />,
    );

    const mentionButton = container.querySelector(".file-tree-action") as HTMLButtonElement | null;
    expect(mentionButton).not.toBeNull();
    fireEvent.click(mentionButton as HTMLButtonElement);

    expect(onInsertText).toHaveBeenCalledWith(
      "@C:\\workspace\\demo\\index.ts ",
    );
  });
});
