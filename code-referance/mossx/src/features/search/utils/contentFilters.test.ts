import { describe, expect, it } from "vitest";
import type { SearchContentFilter } from "../types";
import { toggleSearchContentFilters } from "./contentFilters";

describe("toggleSearchContentFilters", () => {
  it("keeps all as exclusive", () => {
    const next = toggleSearchContentFilters(["files", "threads"], "all");
    expect(next).toEqual(["all"]);
  });

  it("switches from all to concrete filters", () => {
    const next = toggleSearchContentFilters(["all"], "files");
    expect(next).toEqual(["files"]);
  });

  it("supports multi-select and fallback to all when emptied", () => {
    let current: SearchContentFilter[] = ["all"];
    current = toggleSearchContentFilters(current, "files");
    current = toggleSearchContentFilters(current, "threads");
    expect(current).toEqual(["files", "threads"]);

    current = toggleSearchContentFilters(current, "files");
    expect(current).toEqual(["threads"]);

    current = toggleSearchContentFilters(current, "threads");
    expect(current).toEqual(["all"]);
  });
});
