// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationItem } from "../../../../types";
import { SearchToolGroupBlock } from "./SearchToolGroupBlock";

const makeSearchToolItem = (
  id: string,
  query: string,
  output: string,
): Extract<ConversationItem, { kind: "tool" }> => ({
  id,
  kind: "tool",
  toolType: "webSearch",
  title: "Web search",
  detail: JSON.stringify({ query }),
  status: "completed",
  output,
});

describe("SearchToolGroupBlock", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows grouped search output by default without click", () => {
    render(
      <SearchToolGroupBlock
        items={[
          makeSearchToolItem("search-1", "openclaw", "first search output"),
          makeSearchToolItem("search-2", "openclaw security", "second search output"),
        ]}
      />,
    );

    expect(screen.getByText("first search output")).toBeTruthy();
    expect(screen.getByText("second search output")).toBeTruthy();
  });

  it("renders grouped url summary as clickable link", () => {
    render(
      <SearchToolGroupBlock
        items={[
          makeSearchToolItem("search-url", "openclaw", "https://github.com/openclaw/openclaw"),
        ]}
      />,
    );

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://github.com/openclaw/openclaw");
  });

  it("normalizes grouped json query detail to plain readable text", () => {
    render(
      <SearchToolGroupBlock
        items={[
          {
            id: "search-json",
            kind: "tool",
            toolType: "webSearch",
            title: "Web search",
            detail: JSON.stringify({ query: "https://openclaw.ai/" }),
            status: "completed",
            output: "",
          },
        ]}
      />,
    );

    expect(screen.queryByText(/\{"query"/)).toBeNull();
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://openclaw.ai/");
  });
});
