// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useParallelWorkspace } from "./useParallelWorkspace";

describe("useParallelWorkspace", () => {
  it("creates workspace panels from skills", () => {
    const { result } = renderHook(() => useParallelWorkspace());

    act(() => {
      result.current.createWorkspace({
        question: "分析缓存击穿风险",
        skillNames: ["debug", "perf", "security"],
        inheritedCommonsNames: ["项目上下文", "代码规范"],
      });
    });

    expect(result.current.workspace).not.toBeNull();
    expect(result.current.workspace?.question).toBe("分析缓存击穿风险");
    expect(result.current.workspace?.inheritedCommonsNames).toEqual([
      "项目上下文",
      "代码规范",
    ]);
    expect(result.current.workspace?.panels).toHaveLength(3);
    expect(result.current.workspace?.panels.every((panel) => panel.status === "idle")).toBe(
      true,
    );
  });

  it("updates panel status and message", () => {
    const { result } = renderHook(() => useParallelWorkspace());

    act(() => {
      result.current.createWorkspace({
        question: "检查 SQL 慢查询",
        skillNames: ["perf"],
        inheritedCommonsNames: [],
      });
    });

    const panelId = result.current.workspace?.panels[0]?.panelId;
    expect(panelId).toBeTruthy();

    act(() => {
      result.current.updatePanelStatus(panelId!, "queued");
    });
    expect(result.current.workspace?.panels[0]?.status).toBe("queued");

    act(() => {
      result.current.updatePanelStatus(panelId!, "running");
    });
    expect(result.current.workspace?.panels[0]?.status).toBe("running");

    act(() => {
      result.current.updatePanelStatus(panelId!, "error", "query timeout");
    });
    expect(result.current.workspace?.panels[0]?.status).toBe("error");
    expect(result.current.workspace?.panels[0]?.errorMessage).toBe("query timeout");
  });

  it("resets workspace", () => {
    const { result } = renderHook(() => useParallelWorkspace());

    act(() => {
      result.current.createWorkspace({
        question: "写行动计划",
        skillNames: ["docs"],
        inheritedCommonsNames: [],
      });
    });
    expect(result.current.workspace).not.toBeNull();

    act(() => {
      result.current.resetWorkspace();
    });
    expect(result.current.workspace).toBeNull();
  });
});
