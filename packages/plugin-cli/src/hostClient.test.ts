import { describe, expect, it } from "vitest";

import { pingProductHost } from "./productHost.js";

describe("product Host", () => {
  it("rejects a missing token without calling a plugin-dev control plane", async () => {
    expect(
      await pingProductHost({ url: "http://127.0.0.1:9", token: "" }),
    ).toBe(false);
  });
});
