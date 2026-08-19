import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const mcpSource = fileURLToPath(
  new URL("../runtime/mcp-server.mjs", import.meta.url),
);

async function connect(t, options = {}) {
  const client = new Client(
    { name: options.name ?? "vibex-workflow-mcp-test", version: "1.0.0" },
    options.pin
      ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      : undefined,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpSource],
    cwd: pluginRoot,
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

test("serves the 2026-07-28 protocol and exposes dedicated Workflow tools", async (t) => {
  const client = await connect(t, { pin: true });
  assert.equal(client.getProtocolEra(), "modern");
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(names.includes("workflow_source_write"));
  assert.ok(names.includes("workflow_debug_from_step"));
  assert.ok(names.includes("workflow_debug_source"));
  assert.ok(names.includes("workflow_pause_step"));
  assert.ok(names.includes("workflow_review_step"));
  assert.ok(names.includes("workflow_start"));
  assert.ok(names.includes("workflow_cancel_run"));
  const write = listed.tools.find(
    (tool) => tool.name === "workflow_source_write",
  );
  assert.match(
    write?.inputSchema?.properties?.path?.description ?? "",
    /~\/\.vibex\/workflows\//,
  );
  assert.ok(
    listed.tools.find((tool) => tool.name === "workflow_start")?.inputSchema
      ?.properties?.debugStepId,
  );

  const absolute = await client.callTool({
    name: "workflow_source_read",
    arguments: { path: "/tmp/escape.vibex-workflow.json" },
  });
  assert.equal(absolute.isError, true);
  assert.match(
    absolute.content[0].text,
    /project-relative or start with ~\/\.vibex\/workflows\//,
  );
  assert.doesNotMatch(absolute.content[0].text, /must end with/);

  const escaped = await client.callTool({
    name: "workflow_source_read",
    arguments: { path: "../escape.vibex-workflow.json" },
  });
  assert.equal(escaped.isError, true);
  assert.match(escaped.content[0].text, /escapes its authoring root/);
});

test("keeps a negotiated legacy fallback for installed Agents", async (t) => {
  const client = await connect(t, { name: "vibex-workflow-mcp-legacy-test" });
  assert.equal(client.getProtocolEra(), "legacy");
  assert.ok((await client.listTools()).tools.length > 0);
});
