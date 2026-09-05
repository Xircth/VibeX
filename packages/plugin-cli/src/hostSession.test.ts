import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  hostSessionPath,
  loadHostSession,
  mergeHostSession,
  parseHostFlags,
  requireHostSession,
  saveHostSession,
} from "./hostSession.js";

describe("parseHostFlags", () => {
  it("reads a bare --http URL and --token", () => {
    expect(
      parseHostFlags([
        "--http://127.0.0.1:17891",
        "--token",
        "vbx_test",
        ".",
      ]),
    ).toEqual({
      flags: { url: "http://127.0.0.1:17891", token: "vbx_test" },
      rest: ["."],
    });
  });

  it("reads --host= and --token=", () => {
    expect(
      parseHostFlags(["--host=http://127.0.0.1:9", "--token=abc"]),
    ).toEqual({
      flags: { url: "http://127.0.0.1:9", token: "abc" },
      rest: [],
    });
  });

  it("reads --http as a valued flag", () => {
    expect(
      parseHostFlags(["--http", "https://studio.local:17891/", "dev"]),
    ).toEqual({
      flags: { url: "https://studio.local:17891" },
      rest: ["dev"],
    });
  });
});

describe("host session file", () => {
  it("saves and loads a session without echoing extras", () => {
    const home = mkdtempSync(join(tmpdir(), "vibex-pluginrc-"));
    const file = hostSessionPath(home);
    try {
      saveHostSession(
        { url: "http://127.0.0.1:17891", token: "vbx_secret" },
        file,
      );
      expect(loadHostSession(file)).toEqual({
        url: "http://127.0.0.1:17891",
        token: "vbx_secret",
      });
      expect(readFileSync(file, "utf8")).toContain("vbx_secret");
      expect(readFileSync(file, "utf8")).not.toContain("password");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes the session file as owner-only", () => {
    const home = mkdtempSync(join(tmpdir(), "vibex-pluginrc-mode-"));
    const file = hostSessionPath(home);
    try {
      saveHostSession(
        { url: "http://127.0.0.1:17891", token: "vbx_secret" },
        file,
      );
      chmodSync(file, 0o600);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("mergeHostSession", () => {
  it("lets flags override a saved session, then discovered files", () => {
    expect(
      mergeHostSession(
        { token: "flag-token" },
        { url: "http://127.0.0.1:17891", token: "saved" },
        { url: "http://127.0.0.1:9", token: "disk" },
      ),
    ).toEqual({
      url: "http://127.0.0.1:17891",
      token: "flag-token",
    });
  });

  it("returns null when url or token is still missing", () => {
    expect(mergeHostSession({ url: "http://127.0.0.1:17891" }, null, {})).toBe(
      null,
    );
  });
});

describe("requireHostSession", () => {
  it("tells the user to run server when nothing is bound", () => {
    expect(() => requireHostSession(null)).toThrow(/vibex plugin run server/);
  });
});
