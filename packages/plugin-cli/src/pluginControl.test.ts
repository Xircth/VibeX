import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PluginDevHostClient } from "./hostClient.js";
import {
  doctorPlugin,
  installLinkedPlugin,
  uninstallLinkedPlugin,
} from "./pluginControl.js";

describe("plugin Host control commands", () => {
  it("canonicalizes and installs a validated linked package", async () => {
    const root = await fixture();
    let requestBody: unknown;
    const host = await fakeHost(async (request, response) => {
      requestBody = await readJson(request);
      const body = requestBody as {
        expected: { packageDigest: string };
      };
      json(response, 200, {
        protocolVersion: "1.0",
        plugin: { publisher: "tests", id: "notes" },
        generation: 2,
        packageDigest: body.expected.packageDigest,
        state: "active",
      });
    });

    try {
      const result = await installLinkedPlugin(
        root,
        new PluginDevHostClient({ endpoint: host.endpoint, token: "test" }),
      );
      expect(result.generation).toBe(2);
      expect(requestBody).toMatchObject({
        sourcePath: await realpath(root),
        expected: {
          publisher: "tests",
          pluginId: "notes",
          version: "1.0.0",
          packageDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
    } finally {
      host.close();
    }
  });

  it("queries full doctor inventory and uninstalls without deleting data by default", async () => {
    const root = await fixture();
    const seen: Array<{ method?: string; url?: string; body: unknown }> = [];
    const host = await fakeHost(async (request, response) => {
      seen.push({
        method: request.method,
        url: request.url,
        body: request.method === "GET" ? undefined : await readJson(request),
      });
      if (request.method === "GET") {
        json(response, 200, {
          protocolVersion: "1.0",
          plugin: { publisher: "tests", id: "notes" },
          installation: { state: "installed" },
          activation: { generation: 4 },
          grants: [{ capability: "artifact.read" }],
          runtimes: [],
          surfaces: [{ id: "preview" }],
          agentBindings: [],
          recentCrashes: [],
          diagnostics: [],
        });
      } else {
        json(response, 200, {
          protocolVersion: "1.0",
          plugin: { publisher: "tests", id: "notes" },
          removed: true,
          dataRetention: "retained",
        });
      }
    });

    try {
      const client = new PluginDevHostClient({
        endpoint: host.endpoint,
        token: "test",
      });
      const report = await doctorPlugin(root, client);
      expect(report.surfaces).toEqual([{ id: "preview" }]);
      expect(report.grants).toEqual([{ capability: "artifact.read" }]);
      await uninstallLinkedPlugin(root, client, true);
      expect(seen).toEqual([
        {
          method: "GET",
          url: "/api/plugin-dev/v1/plugins/tests/notes/doctor",
          body: undefined,
        },
        {
          method: "DELETE",
          url: "/api/plugin-dev/v1/plugins/tests/notes/linked-installation",
          body: { retainData: true },
        },
      ]);
    } finally {
      host.close();
    }
  });

  it("can diagnose an installed plugin even when its linked candidate is invalid", async () => {
    const root = await fixture();
    const manifestPath = join(root, ".vibex-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    manifest.integrations = [
      { id: "unknown", kind: "app.unknown", resource: "README.md" },
    ];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const host = await fakeHost(async (_request, response) => {
      json(response, 200, {
        protocolVersion: "1.0",
        plugin: { publisher: "tests", id: "notes" },
        installation: { state: "installed" },
        activation: { generation: 4 },
        grants: [],
        runtimes: [],
        surfaces: [],
        agentBindings: [],
        recentCrashes: [],
        diagnostics: [
          {
            code: "linked_candidate_invalid",
            severity: "error",
            message: "The linked source is invalid",
          },
        ],
      });
    });

    try {
      const report = await doctorPlugin(
        root,
        new PluginDevHostClient({ endpoint: host.endpoint, token: "test" }),
      );
      expect(report.diagnostics).toEqual([
        expect.objectContaining({ code: "linked_candidate_invalid" }),
      ]);
    } finally {
      host.close();
    }
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vibex-plugin-control-"));
  await mkdir(join(root, ".vibex-plugin"), { recursive: true });
  await mkdir(join(root, "contents", "workflows", "notes"), {
    recursive: true,
  });
  await writeFile(
    join(root, "README.md"),
    "---\nsummary: Take structured notes from any Agent task.\n---\n# Notes\n",
  );
  await writeFile(join(root, "config.json"), "{}\n");
  await writeFile(
    join(root, "contents", "workflows", "notes", "workflow.json"),
    '{"label":"Notes","entrypoints":["action"],"promptBlocks":[{"type":"text","text":"Take notes."}]}\n',
  );
  await writeFile(
    join(root, ".vibex-plugin", "content.index.json"),
    JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          path: "contents/workflows/notes/workflow.json",
          kind: "workflow",
          title: "Notes",
        },
      ],
    }),
  );
  await writeFile(
    join(root, ".vibex-plugin", "plugin.json"),
    JSON.stringify({
      manifestVersion: 4,
      apiVersion: "1.0",
      id: "notes",
      publisher: "tests",
      version: "1.0.0",
      name: "Notes",
      readme: "README.md",
      engines: { vibex: ">=0.1.3", pluginSdk: "^1.0.0" },
      content: {
        root: "contents",
        index: ".vibex-plugin/content.index.json",
      },
      config: {
        schema: { type: "object", properties: {}, additionalProperties: false },
      },
      permissions: [],
      integrations: [
        {
          id: "notes",
          kind: "workflow.binding",
          resource: "contents/workflows/notes/workflow.json",
        },
      ],
    }),
  );
  return root;
}

async function fakeHost(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>,
) {
  const server = createServer(
    (request, response) => void handler(request, response),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => server.close(),
  };
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
