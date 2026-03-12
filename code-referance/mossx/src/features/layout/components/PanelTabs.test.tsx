// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PanelTabs } from "./PanelTabs";

describe("PanelTabs", () => {
  it("renders top toolbar buttons as non-drag interactive controls", () => {
    const onSelect = vi.fn();

    render(<PanelTabs active="files" onSelect={onSelect} />);

    const filesButton = screen.getByRole("button", { name: "panels.files" });
    const searchButton = screen.getByRole("button", { name: "panels.search" });

    expect(filesButton.getAttribute("data-tauri-drag-region")).toBe("false");
    expect(searchButton.getAttribute("data-tauri-drag-region")).toBe("false");

    fireEvent.click(searchButton);
    expect(onSelect).toHaveBeenCalledWith("search");
  });
});
