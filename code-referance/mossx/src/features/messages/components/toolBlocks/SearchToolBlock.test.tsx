// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SearchToolBlock } from "./SearchToolBlock";

describe("SearchToolBlock", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows raw detail when output is empty", () => {
    render(
      <SearchToolBlock
        item={{
          id: "search-single-1",
          kind: "tool",
          toolType: "webSearch",
          title: "Web search",
          detail: "openclaw github",
          status: "completed",
          output: "",
        }}
        isExpanded={false}
        onToggle={() => {}}
      />,
    );

    expect(screen.getByText("openclaw github")).toBeTruthy();
  });

  it("renders url summary as clickable link", () => {
    render(
      <SearchToolBlock
        item={{
          id: "search-single-2",
          kind: "tool",
          toolType: "webSearch",
          title: "Web search",
          detail: "search openclaw",
          status: "completed",
          output: "https://openclaw.ai/",
        }}
        isExpanded={false}
        onToggle={() => {}}
      />,
    );

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://openclaw.ai/");
  });

  it("normalizes json query detail to plain readable text", () => {
    render(
      <SearchToolBlock
        item={{
          id: "search-single-3",
          kind: "tool",
          toolType: "webSearch",
          title: "Web search",
          detail: JSON.stringify({ query: "https://openclaw.ai/" }),
          status: "completed",
          output: "",
        }}
        isExpanded={false}
        onToggle={() => {}}
      />,
    );

    expect(screen.queryByText(/\{"query"/)).toBeNull();
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://openclaw.ai/");
  });
});
