import { describe, expect, it } from "vitest";
import { deriveKanbanTaskTitle } from "./taskTitle";

describe("deriveKanbanTaskTitle", () => {
  it("compresses long chinese request text into a short title", () => {
    const description =
      "帮我分析一件事现在这个关联项目看板选中后,是新生产一个对话对吧,但是我发现有时候可能对话需要关联当前上下文, 现在是不是不具备这个功能";
    const title = deriveKanbanTaskTitle(description, "Kanban Task");
    expect(title.length).toBeLessThan(description.length);
    expect(title).not.toBe(description);
  });

  it("falls back when description is empty", () => {
    expect(deriveKanbanTaskTitle("   ", "Panel A")).toBe("Panel A");
  });

  it("removes common prefix and keeps semantic core", () => {
    const title = deriveKanbanTaskTitle(
      "请 帮我优化看板关联对话的继承策略",
      "Kanban Task",
    );
    expect(title).toContain("优化看板关联对话的继承策略".slice(0, 2));
  });
});
