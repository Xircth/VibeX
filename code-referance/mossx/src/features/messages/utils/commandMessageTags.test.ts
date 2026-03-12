import { describe, expect, it } from "vitest";
import {
  extractCommandMessageDisplayText,
  hasCommandMessageTag,
} from "./commandMessageTags";

describe("commandMessageTags", () => {
  it("extracts command-message and command-args content", () => {
    const input = `<command-message>aimax:auto</command-message>
<command-name>/aimax:auto</command-name>
<command-args>另外我感觉打包的内容和我想的不符

我希望Mac打两个包
window 和 Linux 各打一个包</command-args>`;

    expect(extractCommandMessageDisplayText(input)).toBe(
      `aimax:auto 另外我感觉打包的内容和我想的不符

我希望Mac打两个包
window 和 Linux 各打一个包`,
    );
  });

  it("returns original text when command-message tag is missing", () => {
    const input = `<command-name>/aimax:auto</command-name>
<command-args>hello</command-args>`;
    expect(extractCommandMessageDisplayText(input)).toBe(input);
  });

  it("detects command-message tags", () => {
    expect(hasCommandMessageTag("<command-message>x</command-message>")).toBe(true);
    expect(hasCommandMessageTag("normal text")).toBe(false);
  });
});
