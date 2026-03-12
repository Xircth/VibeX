import { describe, expect, it } from "vitest";
import {
  assemblePanelPrompt,
  assembleSinglePrompt,
  shouldAssemblePrompt,
} from "./promptAssembler";

describe("promptAssembler", () => {
  it("keeps slash command out of assembly", () => {
    expect(
      shouldAssemblePrompt({
        userInput: "/review src/App.tsx",
        selectedSkillCount: 1,
        selectedCommonsCount: 1,
      }),
    ).toBe(false);
  });

  it("assembles prompt with fixed section order", () => {
    const assembled = assembleSinglePrompt({
      userInput: "请帮我审查这段代码",
      skills: [{ name: "Code Review", description: "找 bug 和风险" }],
      commons: [{ name: "team-rules" }],
    });

    expect(assembled).toContain("/Code-Review");
    expect(assembled).toContain("/team-rules");
    expect(assembled.endsWith("请帮我审查这段代码")).toBe(true);
  });

  it("assembles panel prompt with panel skill and optional extra input", () => {
    const assembled = assemblePanelPrompt({
      workspaceQuestion: "给我一个排查方案",
      panelSkill: { name: "Debug", description: "定位问题根因" },
      inheritedCommons: [{ name: "project-context" }],
      panelExtraInput: "重点关注连接池",
    });

    expect(assembled).toContain("/Debug");
    expect(assembled).toContain("/project-context");
    expect(assembled).toContain("/重点关注连接池");
    expect(assembled.endsWith("给我一个排查方案")).toBe(true);
  });
});
