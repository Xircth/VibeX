import { describe, expect, it } from "vitest";

import { helpText } from "./cli.js";

describe("plugin CLI help", () => {
  it("lists every init template including provider-catalog", () => {
    expect(helpText).toContain(
      "--template skill|mcp|file-tab|editor-tab|full|ts-worker|node-worker|python-worker|rust-worker|host-service|hooks|host-chrome|provider-import|provider-catalog|panel|kanban-view",
    );
  });
});
