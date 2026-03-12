import { describe, expect, it } from "vitest";
import {
  findReleaseIndex,
  normalizeReleaseVersion,
  parseChangelogEntries,
  type ReleaseNotesEntry,
} from "./useReleaseNotes";

const changelogSample = `
# Changelog

---

##### **2026年3月3日（v0.2.2）**

English:

✨ Features
- Add release notes modal

中文：

✨ Features
- 新增版本记录弹窗

---

##### **2026年3月2日（v0.2.1）**

English:
- Previous release

中文：
- 上一个版本
`;

describe("normalizeReleaseVersion", () => {
  it("strips leading v prefix and trims whitespace", () => {
    expect(normalizeReleaseVersion(" v0.2.4 ")).toBe("0.2.4");
    expect(normalizeReleaseVersion("V1.0.0")).toBe("1.0.0");
  });

  it("returns null for empty values", () => {
    expect(normalizeReleaseVersion("")).toBeNull();
    expect(normalizeReleaseVersion("   ")).toBeNull();
    expect(normalizeReleaseVersion(null)).toBeNull();
  });
});

describe("parseChangelogEntries", () => {
  it("extracts bilingual sections from changelog markdown", () => {
    const entries = parseChangelogEntries(changelogSample);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        tagName: "v0.2.2",
        version: "0.2.2",
        dateLabel: "2026/03/03",
      }),
    );
    expect(entries[0]?.englishBody).toContain("Add release notes modal");
    expect(entries[0]?.chineseBody).toContain("新增版本记录弹窗");
  });
});

describe("findReleaseIndex", () => {
  it("matches current version when present", () => {
    const entries: ReleaseNotesEntry[] = [
      {
        id: "0.2.2",
        tagName: "v0.2.2",
        version: "0.2.2",
        title: "v0.2.2",
        dateLabel: "2026/03/03",
        englishBody: "",
        chineseBody: "",
      },
      {
        id: "0.2.1",
        tagName: "v0.2.1",
        version: "0.2.1",
        title: "v0.2.1",
        dateLabel: "2026/03/02",
        englishBody: "",
        chineseBody: "",
      },
    ];

    expect(findReleaseIndex(entries, "0.2.1")).toBe(1);
    expect(findReleaseIndex(entries, "v0.2.2")).toBe(0);
  });

  it("falls back to latest when no match exists", () => {
    const entries: ReleaseNotesEntry[] = [
      {
        id: "0.2.2",
        tagName: "v0.2.2",
        version: "0.2.2",
        title: "v0.2.2",
        dateLabel: "2026/03/03",
        englishBody: "",
        chineseBody: "",
      },
    ];
    expect(findReleaseIndex(entries, "9.9.9")).toBe(0);
    expect(findReleaseIndex(entries, null)).toBe(0);
  });
});
