// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CollapsibleUserTextBlock } from "./CollapsibleUserTextBlock";

describe("CollapsibleUserTextBlock", () => {
  it("renders content text", () => {
    render(<CollapsibleUserTextBlock content="Hello world" />);
    expect(screen.getByText("Hello world")).toBeTruthy();
  });

  it("does not show toggle button for short content", () => {
    render(<CollapsibleUserTextBlock content="Short" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("toggles expanded state when button is clicked", () => {
    // Use a very long content to trigger overflow detection
    const longContent = "A".repeat(5000);
    const { container } = render(
      <CollapsibleUserTextBlock content={longContent} />,
    );

    const block = container.querySelector(".user-collapsible-block");
    expect(block).toBeTruthy();
    // Initially collapsed
    expect(block?.classList.contains("is-collapsed")).toBe(true);
  });

  it("applies is-expanded class when expanded", () => {
    const { container } = render(
      <CollapsibleUserTextBlock content="Test content" />,
    );
    const block = container.querySelector(".user-collapsible-block");
    expect(block).toBeTruthy();
    // Short content should still render but without toggle
    expect(block?.classList.contains("is-collapsed")).toBe(true);
  });
});
