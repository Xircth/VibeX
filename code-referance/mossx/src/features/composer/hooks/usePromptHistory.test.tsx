// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { getClientStoreSync, writeClientStoreValue } from "../../../services/clientStorage";
import { usePromptHistory } from "./usePromptHistory";

function createKeyEvent(key: "ArrowUp" | "ArrowDown") {
  let prevented = false;
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
}

describe("usePromptHistory", () => {
  it("stores and recalls history per workspace key", () => {
    vi.useFakeTimers();
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);

    const { result, rerender, unmount } = renderHook(
      ({ historyKey }) => {
        const [text, setText] = useState("");
        const [, setSelectionStart] = useState<number | null>(null);
        const textareaRef = useRef<HTMLTextAreaElement | null>(textarea);
        const history = usePromptHistory({
          historyKey,
          text,
          disabled: false,
          isAutocompleteOpen: false,
          textareaRef,
          setText,
          setSelectionStart,
        });
        return { text, ...history };
      },
      { initialProps: { historyKey: "ws-1" } },
    );

    act(() => {
      result.current.recordHistory("first prompt");
    });

    // Verify prompt was stored to client store
    const promptHistory = getClientStoreSync<Record<string, string[]>>(
      "composer",
      "promptHistory",
    );
    expect(promptHistory?.["ws-1"]).toEqual(["first prompt"]);

    rerender({ historyKey: "ws-2" });
    act(() => {
      result.current.recordHistory("second prompt");
    });

    const updatedHistory = getClientStoreSync<Record<string, string[]>>(
      "composer",
      "promptHistory",
    );
    expect(updatedHistory?.["ws-2"]).toEqual(["second prompt"]);
    expect(updatedHistory?.["ws-1"]).toEqual(["first prompt"]);

    rerender({ historyKey: "ws-1" });
    act(() => {
      result.current.handleHistoryKeyDown(createKeyEvent("ArrowUp"));
    });
    act(() => {
      vi.runAllTimers();
    });
    expect(result.current.text).toBe("first prompt");

    unmount();
    textarea.remove();
    vi.useRealTimers();
  });

  it("does not clobber stored history when switching keys", () => {
    // Pre-populate the client store with history data
    writeClientStoreValue("composer", "promptHistory", {
      "ws-a": ["alpha prompt"],
      "ws-b": ["beta prompt"],
    });

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);

    const { rerender, unmount } = renderHook(
      ({ historyKey }) => {
        const [text, setText] = useState("");
        const [, setSelectionStart] = useState<number | null>(null);
        const textareaRef = useRef<HTMLTextAreaElement | null>(textarea);
        return usePromptHistory({
          historyKey,
          text,
          disabled: false,
          isAutocompleteOpen: false,
          textareaRef,
          setText,
          setSelectionStart,
        });
      },
      { initialProps: { historyKey: "ws-a" } },
    );

    rerender({ historyKey: "ws-b" });

    const historyAfterSwitch = getClientStoreSync<Record<string, string[]>>(
      "composer",
      "promptHistory",
    );
    expect(historyAfterSwitch?.["ws-a"]).toEqual(["alpha prompt"]);
    expect(historyAfterSwitch?.["ws-b"]).toEqual(["beta prompt"]);

    unmount();
    textarea.remove();
  });
});
