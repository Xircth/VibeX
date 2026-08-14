import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { describe, expect, it } from "vitest";

import {
  PluginDevHostClient,
  resolvePluginDevConnection,
} from "./hostClient.js";

describe("PluginDevHostClient", () => {
  it("uses only explicit Plugin Dev configuration and gives flags precedence", () => {
    expect(
      resolvePluginDevConnection(
        ["--host", "http://localhost:4312", "--token", "flag-token"],
        {
          VIBEX_PLUGIN_DEV_HOST: "http://127.0.0.1:4313",
          VIBEX_PLUGIN_DEV_TOKEN: "env-token",
          VIBEX_AUTH_TOKEN: "main-bearer-must-not-be-read",
        },
      ),
    ).toEqual({ endpoint: "http://localhost:4312", token: "flag-token" });

    expect(() =>
      resolvePluginDevConnection([], {
        VIBEX_AUTH_TOKEN: "main-bearer-must-not-be-read",
      }),
    ).toThrow("plugin_dev_host_missing");
  });

  it("rejects non-loopback and authenticated URL endpoints", () => {
    expect(
      () =>
        new PluginDevHostClient({
          endpoint: "https://example.com",
          token: "test",
        }),
    ).toThrow("plugin_dev_host_must_be_loopback_http_origin");
    expect(
      () =>
        new PluginDevHostClient({
          endpoint: "http://user:secret@localhost:4312",
          token: "test",
        }),
    ).toThrow("plugin_dev_host_must_be_loopback_http_origin");
  });

  it("installs a linked candidate through the authenticated localhost control protocol", async () => {
    const requests: Array<{
      method?: string;
      url?: string;
      token?: string | string[];
      protocol?: string | string[];
      body: unknown;
    }> = [];
    const server = createServer(async (request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        token: request.headers["x-vibex-plugin-dev-token"],
        protocol: request.headers["x-vibex-plugin-dev-protocol"],
        body: await readJson(request),
      });
      json(response, 200, {
        protocolVersion: "1.0",
        plugin: { publisher: "tests", id: "markdown-lens" },
        generation: 7,
        packageDigest: "sha256-package",
        state: "active",
      });
    });
    const endpoint = await listen(server);

    try {
      const client = new PluginDevHostClient({ endpoint, token: "dev-secret" });
      const result = await client.installLinked({
        sourcePath: "/tmp/markdown-lens",
        expected: {
          publisher: "tests",
          pluginId: "markdown-lens",
          version: "1.0.0",
          packageDigest: "sha256-package",
        },
      });

      expect(result).toEqual({
        protocolVersion: "1.0",
        plugin: { publisher: "tests", id: "markdown-lens" },
        generation: 7,
        packageDigest: "sha256-package",
        state: "active",
      });
      expect(requests).toEqual([
        {
          method: "POST",
          url: "/api/plugin-dev/v1/linked-installations",
          token: "dev-secret",
          protocol: "1.0",
          body: {
            sourcePath: "/tmp/markdown-lens",
            expected: {
              publisher: "tests",
              pluginId: "markdown-lens",
              version: "1.0.0",
              packageDigest: "sha256-package",
            },
          },
        },
      ]);
    } finally {
      server.close();
    }
  });

  it("preserves the published generation from a rejected candidate error", async () => {
    const server = createServer((_request, response) => {
      json(response, 409, {
        error: {
          code: "candidate_activation_failed",
          message: "Worker registration failed",
          retryable: false,
          diagnosticId: "diag-7",
          publishedGeneration: 6,
        },
      });
    });
    const endpoint = await listen(server);

    try {
      const client = new PluginDevHostClient({ endpoint, token: "dev-secret" });
      await expect(
        client.reloadCandidate(
          { publisher: "tests", id: "markdown-lens" },
          {
            sourcePath: "/tmp/markdown-lens",
            expectedPackageDigest: "bad-candidate",
          },
        ),
      ).rejects.toMatchObject({
        code: "candidate_activation_failed",
        diagnosticId: "diag-7",
        publishedGeneration: 6,
      });
    } finally {
      server.close();
    }
  });

  it("rejects malformed successful doctor responses", async () => {
    const server = createServer((_request, response) => {
      json(response, 200, {
        protocolVersion: "1.0",
        plugin: { publisher: "tests", id: "markdown-lens" },
      });
    });
    const endpoint = await listen(server);

    try {
      const client = new PluginDevHostClient({ endpoint, token: "dev-secret" });
      await expect(
        client.doctor({ publisher: "tests", id: "markdown-lens" }),
      ).rejects.toMatchObject({ code: "plugin_dev_response_invalid" });
    } finally {
      server.close();
    }
  });
});

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
