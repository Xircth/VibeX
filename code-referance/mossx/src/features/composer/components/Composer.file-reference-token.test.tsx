/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerEditorSettings } from "../../../types";
import { Composer } from "./Composer";

afterEach(() => {
  cleanup();
});

vi.mock("../../../services/dragDrop", () => ({
  subscribeWindowDragDrop: vi.fn(() => () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `tauri://${path}`,
  invoke: vi.fn(async () => null),
}));

vi.mock("../../engine/components/EngineSelector", () => ({
  EngineSelector: () => null,
}));

vi.mock("../../opencode/components/OpenCodeControlPanel", () => ({
  OpenCodeControlPanel: () => null,
}));

vi.mock("./ChatInputBox/ChatInputBoxAdapter", () => ({
  ChatInputBoxAdapter: ({
    text,
    onTextChange,
    onSend,
  }: {
    text: string;
    onTextChange: (next: string, cursor: number | null) => void;
    onSend: () => void;
  }) => (
    <textarea
      value={text}
      onChange={(event) =>
        onTextChange(event.currentTarget.value, event.currentTarget.value.length)
      }
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onSend();
        }
      }}
    />
  ),
}));

function ComposerHarness({ onSend }: { onSend: (text: string) => void }) {
  const [draftText, setDraftText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const editorSettings: ComposerEditorSettings = {
    preset: "default",
    expandFenceOnSpace: false,
    expandFenceOnEnter: false,
    fenceLanguageTags: false,
    fenceWrapSelection: false,
    autoWrapPasteMultiline: false,
    autoWrapPasteCodeLike: false,
    continueListOnShiftEnter: false,
  };

  return (
    <Composer
      onSend={(text) => onSend(text)}
      onQueue={() => {}}
      onStop={() => {}}
      canStop={false}
      isProcessing={false}
      steerEnabled={false}
      collaborationModes={[]}
      collaborationModesEnabled={true}
      selectedCollaborationModeId={null}
      onSelectCollaborationMode={() => {}}
      selectedEngine="claude"
      models={[]}
      selectedModelId={null}
      onSelectModel={() => {}}
      reasoningOptions={[]}
      selectedEffort={null}
      onSelectEffort={() => {}}
      reasoningSupported={false}
      accessMode="current"
      onSelectAccessMode={() => {}}
      skills={[]}
      prompts={[]}
      commands={[]}
      files={[]}
      draftText={draftText}
      onDraftChange={setDraftText}
      textareaRef={textareaRef}
      dictationEnabled={false}
      editorSettings={editorSettings}
      activeWorkspaceId="ws-1"
      activeThreadId="thread-1"
    />
  );
}

function getTextarea(container: HTMLElement) {
  const textarea = container.querySelector("textarea");
  if (!textarea) {
    throw new Error("Textarea not found");
  }
  return textarea as HTMLTextAreaElement;
}

describe("Composer file reference token", () => {
  it("converts visual file tokens to absolute paths before send", async () => {
    const onSend = vi.fn();
    const view = render(<ComposerHarness onSend={onSend} />);
    const textarea = getTextarea(view.container);

    const value =
      "请检查 📁 src-tauri `/Users/demo/repo/src-tauri` 和 📄 App.tsx `/Users/demo/repo/src/App.tsx`";

    await act(async () => {
      fireEvent.change(textarea, {
        target: {
          value,
          selectionStart: value.length,
        },
      });
      textarea.focus();
      textarea.setSelectionRange(value.length, value.length);
      fireEvent.select(textarea);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(textarea.value).toBe("请检查 📁 src-tauri 和 📄 App.tsx");

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", bubbles: true });
    });

    expect(onSend).toHaveBeenCalledWith(
      "请检查 /Users/demo/repo/src-tauri 和 /Users/demo/repo/src/App.tsx",
    );
  });

  it("deduplicates repeated references for the same path", async () => {
    const onSend = vi.fn();
    const view = render(<ComposerHarness onSend={onSend} />);
    const textarea = getTextarea(view.container);

    const value =
      "📁 ai-reach `/Users/demo/repo/ai-reach`  📁 ai-reach `/Users/demo/repo/ai-reach`";

    await act(async () => {
      fireEvent.change(textarea, {
        target: {
          value,
          selectionStart: value.length,
        },
      });
      textarea.focus();
      textarea.setSelectionRange(value.length, value.length);
      fireEvent.select(textarea);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(textarea.value).toBe("📁 ai-reach  ");

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", bubbles: true });
    });

    expect(onSend).toHaveBeenCalledWith("/Users/demo/repo/ai-reach");
  });

  it("keeps existing visible reference when duplicate token is appended", async () => {
    const onSend = vi.fn();
    const view = render(<ComposerHarness onSend={onSend} />);
    const textarea = getTextarea(view.container);

    const value =
      "📁 ai-reach  📁 ai-reach `/Users/demo/repo/ai-reach`  ";

    await act(async () => {
      fireEvent.change(textarea, {
        target: {
          value,
          selectionStart: value.length,
        },
      });
      textarea.focus();
      textarea.setSelectionRange(value.length, value.length);
      fireEvent.select(textarea);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(textarea.value).toBe("📁 ai-reach  ");
  });

  it("keeps one visible label when stale duplicate tokens re-enter text", async () => {
    const onSend = vi.fn();
    const view = render(<ComposerHarness onSend={onSend} />);
    const textarea = getTextarea(view.container);

    const singleToken = "📁 ai-reach `/Users/demo/repo/ai-reach`  ";
    await act(async () => {
      fireEvent.change(textarea, {
        target: {
          value: singleToken,
          selectionStart: singleToken.length,
        },
      });
      textarea.focus();
      textarea.setSelectionRange(singleToken.length, singleToken.length);
      fireEvent.select(textarea);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(textarea.value).toBe("📁 ai-reach  ");

    const staleDuplicatedTokens =
      "📁 ai-reach `/Users/demo/repo/ai-reach`  📁 ai-reach `/Users/demo/repo/ai-reach`  ";
    await act(async () => {
      fireEvent.change(textarea, {
        target: {
          value: staleDuplicatedTokens,
          selectionStart: staleDuplicatedTokens.length,
        },
      });
      textarea.focus();
      textarea.setSelectionRange(
        staleDuplicatedTokens.length,
        staleDuplicatedTokens.length,
      );
      fireEvent.select(textarea);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(textarea.value).toBe("📁 ai-reach  ");

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", bubbles: true });
    });

    expect(onSend).toHaveBeenCalledWith("/Users/demo/repo/ai-reach");
  });
});
