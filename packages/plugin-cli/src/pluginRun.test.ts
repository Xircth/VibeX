import { describe, expect, it } from "vitest";

import { bindHostServer, parseRunInvocation } from "./pluginRun.js";

describe("parseRunInvocation", () => {
  it("parses run server with a bare HTTP flag", () => {
    expect(
      parseRunInvocation([
        "server",
        "--http://127.0.0.1:17891",
        "--token",
        "vbx_test",
      ]),
    ).toEqual({
      script: "server",
      host: { url: "http://127.0.0.1:17891", token: "vbx_test" },
      positional: [],
      hostJourney: false,
    });
  });

  it("parses run dev from the current directory", () => {
    expect(parseRunInvocation(["dev"])).toEqual({
      script: "dev",
      host: {},
      positional: [],
      hostJourney: false,
    });
  });

  it("parses run test --host", () => {
    expect(parseRunInvocation(["test", "--host", "my-plugin"])).toEqual({
      script: "test",
      host: {},
      positional: ["my-plugin"],
      hostJourney: true,
    });
  });

  it("rejects an unknown script", () => {
    expect(() => parseRunInvocation(["start"])).toThrow(/Unknown plugin script/);
  });

  it("prints usage when the script is missing", () => {
    expect(() => parseRunInvocation([])).toThrow(
      /^Usage: vibex plugin run <server\|dev\|build\|test>$/,
    );
  });
});

describe("bindHostServer", () => {
  it("pings then saves a complete session", async () => {
    const saved: Array<{ url: string; token: string }> = [];
    const session = await bindHostServer({
      flags: { url: "http://127.0.0.1:17891", token: "vbx_test" },
      saved: null,
      ping: async () => true,
      save: (value) => {
        saved.push(value);
      },
    });
    expect(session).toEqual({
      url: "http://127.0.0.1:17891",
      token: "vbx_test",
    });
    expect(saved).toEqual([session]);
  });

  it("does not save when the Host rejects the token", async () => {
    const saved: unknown[] = [];
    await expect(
      bindHostServer({
        flags: { url: "http://127.0.0.1:17891", token: "bad" },
        saved: null,
        ping: async () => false,
        save: (value) => saved.push(value),
      }),
    ).rejects.toThrow(/did not accept/);
    expect(saved).toEqual([]);
  });

  it("reuses a saved URL when only a token is passed", async () => {
    const session = await bindHostServer({
      flags: { token: "vbx_new" },
      saved: { url: "http://127.0.0.1:17891", token: "old" },
      ping: async () => true,
      save: () => {},
    });
    expect(session.url).toBe("http://127.0.0.1:17891");
    expect(session.token).toBe("vbx_new");
  });
});
