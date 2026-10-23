import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeProtocolMessage } from "./protocol.js";
import { definePluginWorker } from "./worker.js";

const originalStdin = process.stdin;
const originalStdout = process.stdout;

afterEach(() => {
  Object.defineProperty(process, "stdin", { value: originalStdin });
  Object.defineProperty(process, "stdout", { value: originalStdout });
  vi.resetModules();
});

describe("stdio worker protocol", () => {
  it("activates before invoking and returns protocol-safe responses", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    Object.defineProperty(process, "stdin", { value: input });
    Object.defineProperty(process, "stdout", { value: output });
    const { runStdioPluginWorker } = await import("./stdio.js");
    const run = runStdioPluginWorker(
      definePluginWorker((plugin) => {
        plugin.handle("echo.run", (value) => value);
      }),
    );

    input.write(
      `${JSON.stringify({
        id: "1",
        method: "activate",
        params: {
          pluginId: "dev.vibex.echo",
          pluginVersion: "1.0.0",
          generation: 1,
          grantedCapabilities: [],
        },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: "2",
        method: "invoke",
        params: { handler: "echo.run", input: { value: 42 } },
      })}\n`,
    );
    input.end();
    await run;

    expect(
      transcript
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { id: "1", ok: true, result: { handlers: ["echo.run"] } },
      { id: "2", ok: true, result: { value: 42 } },
    ]);
  });

  it("keeps reading Host responses while a handler awaits a capability call", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const messages: Array<Record<string, unknown>> = [];
    Object.defineProperty(process, "stdin", { value: input });
    Object.defineProperty(process, "stdout", { value: output });
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as Record<string, unknown>;
        messages.push(message);
        if (message.method === "host.call") {
          input.write(
            `${JSON.stringify({ id: message.id, ok: true, result: { allowed: true } })}\n`,
          );
        }
        if (message.id === "2" && message.ok === true) input.end();
      }
    });
    const { runStdioPluginWorker } = await import("./stdio.js");
    const run = runStdioPluginWorker(
      definePluginWorker((plugin, environment) => {
        plugin.handle("broker.run", () =>
          environment.host.call("runtime.execute", "preview", {}),
        );
      }),
    );
    input.write(
      `${JSON.stringify({
        id: "1",
        method: "activate",
        params: {
          pluginId: "dev.vibex.broker",
          pluginVersion: "1.0.0",
          generation: 1,
          grantedCapabilities: ["runtime.execute"],
        },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: "2",
        method: "invoke",
        params: { handler: "broker.run", input: null },
      })}\n`,
    );
    await run;
    expect(messages.at(-1)).toEqual({
      id: "2",
      ok: true,
      result: { allowed: true },
    });
  });

  it("reassembles a chunked image invoke and keeps the worker after a bad chunk", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const messages: Array<Record<string, unknown>> = [];
    Object.defineProperty(process, "stdin", { value: input });
    Object.defineProperty(process, "stdout", { value: output });
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n").filter(Boolean)) {
        messages.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    const { runStdioPluginWorker } = await import("./stdio.js");
    const run = runStdioPluginWorker(
      definePluginWorker((plugin) => {
        plugin.handle("draw", (value) => value);
      }),
    );
    input.write(
      `${JSON.stringify({
        id: "1",
        method: "activate",
        params: {
          pluginId: "studio.draw",
          pluginVersion: "1.0.0",
          generation: 1,
          grantedCapabilities: ["*"],
        },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: "chunk:0",
        method: "image.chunk",
        params: { index: 0, data: "AAAA" },
      })}\n`,
    );
    const image = "A".repeat(4000);
    const frames = encodeProtocolMessage(
      {
        id: "2",
        method: "invoke",
        params: { handler: "draw", input: { data: image } },
      },
      { maxFrameBytes: 180, maxLogicalBytes: 64 * 1024 },
    );
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) input.write(`${frame}\n`);
    input.end();
    await run;
    const rejected = messages.find((message) => message.id === "chunk:0");
    expect(rejected).toMatchObject({
      id: "chunk:0",
      ok: false,
      error: { code: "protocol_invalid" },
    });
    const drawn = messages.find((message) => message.id === "2");
    expect(drawn).toMatchObject({
      id: "2",
      ok: true,
      result: { data: image },
    });
  });

  it("adopts the advertised frame limit and rejects a larger line", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const messages: Array<Record<string, unknown>> = [];
    Object.defineProperty(process, "stdin", { value: input });
    Object.defineProperty(process, "stdout", { value: output });
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n").filter(Boolean)) {
        messages.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    const { runStdioPluginWorker } = await import("./stdio.js");
    const run = runStdioPluginWorker(
      definePluginWorker((plugin) => {
        plugin.handle("draw", (value) => value);
      }),
    );
    input.write(
      `${JSON.stringify({
        id: "1",
        method: "initialize",
        params: {
          protocolRange: ["1.1"],
          hostVersion: "0.2.8",
          pluginIdentity: { publisher: "studio", id: "draw" },
          packageVersion: "1.0.0",
          packageDigest: "sha256:test",
          generationId: 1,
          declaredContributions: [],
          packageClass: "full-trust",
          features: [],
          limits: { maxFrameBytes: 1024 * 1024, requestTimeoutMs: 30000 },
          runtime: {
            id: "node",
            version: "22.22.3",
            target: "test",
            digest: "sha256:host",
          },
        },
      })}\n`,
    );
    input.write(`${"x".repeat(1024 * 1024 + 32)}\n`);
    input.end();
    await run;
    expect(messages[0]).toMatchObject({ id: "1", ok: true });
    expect(messages[1]).toMatchObject({
      id: "unknown",
      ok: false,
      error: { code: "worker_frame_too_large" },
    });
  });

  it("detects when running inside the multiplexed SharedNodeWorkerHost", async () => {
    const { getSharedNodePluginHost, isSharedNodePluginHost } = await import(
      "./stdio.js"
    );
    expect(isSharedNodePluginHost()).toBe(false);
    expect(getSharedNodePluginHost()).toBeNull();

    const slots = new Map([
      [
        "dev.vibex.one#1",
        {
          pluginId: "dev.vibex.one",
          generation: 1,
          cwd: "/plugins/one",
          entrypoint: "/plugins/one/worker.mjs",
          disposed: false,
        },
      ],
    ]);
    const services = new Map<string, unknown>([["shared.cache", { ok: true }]]);
    (globalThis as Record<string, unknown>).__VIBEX_SHARED_PLUGIN_HOST__ = {
      slots,
      services,
    };
    try {
      expect(isSharedNodePluginHost()).toBe(true);
      const host = getSharedNodePluginHost();
      expect(host?.slots.size).toBe(1);
      expect(host?.services.get("shared.cache")).toEqual({ ok: true });
    } finally {
      delete (globalThis as Record<string, unknown>)
        .__VIBEX_SHARED_PLUGIN_HOST__;
    }
  });
});
