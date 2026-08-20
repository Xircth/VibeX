import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("serves the 2026-07-28 protocol and exposes dedicated Workflow tools", async (t) => {
  const client = new Client(
    { name: "vibex-workflow-mcp-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/mcp/workflow-control.mjs"],
    cwd: new URL("..", import.meta.url),
    stderr: "pipe",
  });
  t.after(() => client.close());

  await client.connect(transport);
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
  assert.ok(
    listed.tools.find((tool) => tool.name === "workflow_start")?.inputSchema
      ?.properties?.debugStepId,
  );

  const escaped = await client.callTool({
    name: "workflow_source_read",
    arguments: { path: "/tmp/escape.vibex-workflow.json" },
  });
  assert.equal(escaped.isError, true);
  assert.match(escaped.content[0].text, /path must end with/);
});

test("keeps a negotiated legacy fallback for installed Agents", async (t) => {
  const client = new Client({
    name: "vibex-workflow-mcp-legacy-test",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/mcp/workflow-control.mjs"],
    cwd: new URL("..", import.meta.url),
    stderr: "pipe",
  });
  t.after(() => client.close());

  await client.connect(transport);
  assert.equal(client.getProtocolEra(), "legacy");
  assert.ok((await client.listTools()).tools.length > 0);
});
