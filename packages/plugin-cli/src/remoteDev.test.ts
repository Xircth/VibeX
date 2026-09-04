import { describe, expect, it } from "vitest";

import { remotesFromManifest } from "./remoteDev.js";

describe("remotesFromManifest", () => {
  it("collects federation remotes from structure contributions", () => {
    expect(
      remotesFromManifest({
        integrations: [
          {
            kind: "app.panel",
            remote: { name: "panel", entry: "dist/remoteEntry.js" },
          },
          { kind: "app.command" },
        ],
      }),
    ).toEqual([
      { name: "panel", entry: "dist/remoteEntry.js", module: "./view" },
    ]);
  });
});
