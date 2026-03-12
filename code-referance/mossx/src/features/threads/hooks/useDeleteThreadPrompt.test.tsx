// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDeleteThreadPrompt } from "./useDeleteThreadPrompt";

describe("useDeleteThreadPrompt", () => {
  it("opens prompt with matched thread name", () => {
    const removeThread = vi.fn().mockResolvedValue({ success: true, message: null });
    const { result } = renderHook(() =>
      useDeleteThreadPrompt({
        threadsByWorkspace: {
          "ws-1": [{ id: "thread-1", name: "待删除会话", updatedAt: 1 }],
        },
        removeThread,
      }),
    );

    act(() => {
      result.current.openDeletePrompt("ws-1", "thread-1");
    });

    expect(result.current.deletePrompt).toEqual({
      workspaceId: "ws-1",
      threadId: "thread-1",
      threadName: "待删除会话",
    });
  });

  it("confirms deletion and calls success callback", async () => {
    const removeThread = vi.fn().mockResolvedValue({ success: true, message: null });
    const onDeleteSuccess = vi.fn();
    const onDeleteError = vi.fn();
    const { result } = renderHook(() =>
      useDeleteThreadPrompt({
        threadsByWorkspace: {
          "ws-1": [{ id: "thread-1", name: "待删除会话", updatedAt: 1 }],
        },
        removeThread,
        onDeleteSuccess,
        onDeleteError,
      }),
    );

    act(() => {
      result.current.openDeletePrompt("ws-1", "thread-1");
    });

    await act(async () => {
      await result.current.handleDeletePromptConfirm();
    });

    expect(removeThread).toHaveBeenCalledWith("ws-1", "thread-1");
    expect(onDeleteSuccess).toHaveBeenCalledWith("thread-1");
    expect(onDeleteError).not.toHaveBeenCalled();
    expect(result.current.deletePrompt).toBeNull();
  });

  it("keeps prompt open when deletion fails", async () => {
    const removeThread = vi.fn().mockResolvedValue({ success: false, message: "boom" });
    const onDeleteSuccess = vi.fn();
    const onDeleteError = vi.fn();
    const { result } = renderHook(() =>
      useDeleteThreadPrompt({
        threadsByWorkspace: {
          "ws-1": [{ id: "thread-1", name: "待删除会话", updatedAt: 1 }],
        },
        removeThread,
        onDeleteSuccess,
        onDeleteError,
      }),
    );

    act(() => {
      result.current.openDeletePrompt("ws-1", "thread-1");
    });

    await act(async () => {
      await result.current.handleDeletePromptConfirm();
    });

    expect(onDeleteSuccess).not.toHaveBeenCalled();
    expect(onDeleteError).toHaveBeenCalledWith("boom");
    expect(result.current.deletePrompt?.threadId).toBe("thread-1");
  });
});
