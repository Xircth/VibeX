// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RequestUserInputRequest } from "../../../types";
import { useThreadUserInputEvents } from "./useThreadUserInputEvents";

const baseRequest: RequestUserInputRequest = {
  workspace_id: "ws-1",
  request_id: "req-1",
  params: {
    thread_id: "thread-1",
    turn_id: "turn-1",
    item_id: "item-1",
    questions: [{ id: "q1", header: "", question: "Continue?" }],
  },
};

describe("useThreadUserInputEvents", () => {
  it("adds requestUserInput into queue when request is not completed", () => {
    const dispatch = vi.fn();
    const { result } = renderHook(() => useThreadUserInputEvents({ dispatch }));

    act(() => {
      result.current(baseRequest);
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "addUserInputRequest",
      request: baseRequest,
    });
  });

  it("removes request when completed is true", () => {
    const dispatch = vi.fn();
    const { result } = renderHook(() => useThreadUserInputEvents({ dispatch }));

    act(() => {
      result.current({
        ...baseRequest,
        params: {
          ...baseRequest.params,
          completed: true,
        },
      });
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "removeUserInputRequest",
      requestId: "req-1",
      workspaceId: "ws-1",
    });
  });

  it("ignores stale non-completed event after completed event for same request", () => {
    const dispatch = vi.fn();
    const { result } = renderHook(() => useThreadUserInputEvents({ dispatch }));

    act(() => {
      result.current({
        ...baseRequest,
        params: {
          ...baseRequest.params,
          completed: true,
        },
      });
    });

    act(() => {
      result.current(baseRequest);
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "removeUserInputRequest",
      requestId: "req-1",
      workspaceId: "ws-1",
    });
  });
});
