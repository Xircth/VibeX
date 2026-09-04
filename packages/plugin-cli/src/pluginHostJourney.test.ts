import { describe, expect, it } from "vitest";

import {
  catalogHasKinds,
  catalogLacksKinds,
  chromeKindsFromIntegrations,
  liveKindsForPlugin,
} from "./pluginHostJourney.js";

const hostChromeIntegrations = [
  { id: "command", kind: "app.command" },
  { id: "toolbar", kind: "app.toolbar" },
  { id: "status", kind: "app.status" },
  { id: "slash", kind: "app.composer.slash" },
  { id: "card", kind: "app.timeline.card" },
  { id: "section", kind: "app.settings.section" },
  { id: "poll", kind: "host.service" },
];

describe("chromeKindsFromIntegrations", () => {
  it("collects the six chrome slots and ignores other kinds", () => {
    expect(chromeKindsFromIntegrations(hostChromeIntegrations)).toEqual([
      "app.command",
      "app.toolbar",
      "app.status",
      "app.composer.slash",
      "app.timeline.card",
      "app.settings.section",
    ]);
  });

  it("returns nothing for a skill-only package", () => {
    expect(chromeKindsFromIntegrations([{ kind: "content.skill" }])).toEqual(
      [],
    );
  });
});

describe("live contribution catalog", () => {
  const items = [
    { pluginId: "vibex.host-chrome", kind: "app.command" },
    { pluginId: "vibex.host-chrome", kind: "app.status" },
    { pluginId: "other.plugin", kind: "app.command" },
  ];

  it("only counts the plugin under test", () => {
    expect(liveKindsForPlugin(items, "vibex.host-chrome")).toEqual([
      "app.command",
      "app.status",
    ]);
  });

  it("treats enable as every declared kind present", () => {
    expect(
      catalogHasKinds(items, "vibex.host-chrome", ["app.command", "app.status"]),
    ).toBe(true);
    expect(
      catalogHasKinds(items, "vibex.host-chrome", ["app.command", "app.toolbar"]),
    ).toBe(false);
  });

  it("treats disable as every declared kind gone", () => {
    expect(catalogLacksKinds(items, "vibex.host-chrome", ["app.toolbar"])).toBe(
      true,
    );
    expect(catalogLacksKinds(items, "vibex.host-chrome", ["app.command"])).toBe(
      false,
    );
  });
});
