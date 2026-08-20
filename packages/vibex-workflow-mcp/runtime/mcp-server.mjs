#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  relative as relativePath,
  resolve,
} from "node:path";

import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const SERVER_URL = (process.env.VIBEX_SERVER_URL || "").replace(/\/+$/, "");
const SERVER_TOKEN = process.env.VIBEX_SERVER_TOKEN || "";
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

const tools = [
  tool(
    "workflow_source_read",
    "Read a workspace Workflow source artifact and its CAS revision.",
    {
      path: stringProperty(
        "Project-relative path or ~/.vibex/workflows/*.vibex-workflow.json",
      ),
    },
    ["path"],
  ),
  tool(
    "workflow_source_write",
    "Validate and atomically save a Workflow source artifact. Existing files require the revision returned by workflow_source_read.",
    {
      path: stringProperty("Project-relative *.vibex-workflow.json path"),
      definition: { type: "object" },
      expectedRevision: stringProperty(
        "sha256 revision for an existing source",
      ),
    },
    ["path", "definition"],
  ),
  tool(
    "workflow_validate",
    "Validate and normalize a Workflow definition without publishing it.",
    {
      definition: { type: "object" },
    },
    ["definition"],
  ),
  tool(
    "workflow_publish",
    "Publish an immutable version from a valid source definition.",
    {
      definition: { type: "object" },
      sourcePath: stringProperty("Project-relative source identity"),
      definitionId: stringProperty("Existing reusable Workflow definition ID"),
    },
    ["definition", "sourcePath"],
  ),
  tool(
    "workflow_catalog",
    "List reusable Workflow definitions and optionally their version history.",
    {
      definitionId: stringProperty(
        "Definition ID whose versions should be returned",
      ),
    },
  ),
  tool(
    "workflow_run_inspect",
    "Inspect one durable Run, all latest/previous step attempts, and its complete event history.",
    {
      runId: stringProperty("Workflow Run ID"),
    },
    ["runId"],
  ),
  tool(
    "workflow_start",
    "Start a durable Workflow Run from a published immutable version.",
    {
      definitionVersionId: stringProperty("Published Workflow version ID"),
      workspaceId: stringProperty("VibeX workspace ID"),
      input: {},
      policyOverride: { type: ["object", "null"] },
      debugStepId: stringProperty(
        "Optional Agent Step to test with only its required ancestors",
      ),
    },
    ["definitionVersionId", "workspaceId", "input"],
  ),
  tool(
    "workflow_debug_source",
    "Test the current source definition through an unpublished durable debug Run. Reuses completed ancestors when parentRunId is provided and never publishes or retargets an Automation.",
    {
      definition: { type: "object" },
      sourcePath: stringProperty("Project-relative source identity"),
      definitionId: stringProperty("Existing reusable Workflow definition ID"),
      workspaceId: stringProperty(
        "VibeX workspace ID; required only for the first debug Run",
      ),
      input: {},
      policyOverride: { type: ["object", "null"] },
      stepId: stringProperty("Agent Step to test"),
      parentRunId: stringProperty(
        "Prior debug Run whose unchanged completed ancestors should be reused",
      ),
      scope: { type: "string", enum: ["node", "downstream"] },
    },
    ["definition", "sourcePath", "stepId"],
  ),
  tool(
    "workflow_debug_from_step",
    "Create a derived debug Run that preserves unchanged completed ancestors and reruns one node or its transitive downstream.",
    {
      parentRunId: stringProperty("Existing parent Run ID"),
      definitionVersionId: stringProperty("Published version to debug"),
      stepId: stringProperty("Agent Step ID"),
      scope: { type: "string", enum: ["node", "downstream"] },
    },
    ["parentRunId", "definitionVersionId", "stepId", "scope"],
  ),
  tool(
    "workflow_pause_run",
    "Pause the DAG and cancel active Turns without marking the Run failed.",
    {
      runId: stringProperty("Workflow Run ID"),
      reason: stringProperty("Audit reason"),
    },
    ["runId"],
  ),
  tool(
    "workflow_cancel_run",
    "Permanently terminate a Workflow Run and its active Agent Turns.",
    {
      runId: stringProperty("Workflow Run ID"),
      reason: stringProperty("Audit reason"),
    },
    ["runId"],
  ),
  tool(
    "workflow_resume_run",
    "Resume a paused DAG from its paused nodes with new Turns.",
    {
      runId: stringProperty("Workflow Run ID"),
    },
    ["runId"],
  ),
  tool(
    "workflow_pause_step",
    "Pause only the active Turn in one Agent Step Conversation.",
    {
      runId: stringProperty("Workflow Run ID"),
      stepId: stringProperty("Agent Step ID"),
      reason: stringProperty("Audit reason"),
    },
    ["runId", "stepId"],
  ),
  tool(
    "workflow_continue_step",
    "Continue a paused Agent Step by adding a new Turn in the same Conversation.",
    {
      runId: stringProperty("Workflow Run ID"),
      stepId: stringProperty("Agent Step ID"),
      text: stringProperty("Additional user guidance"),
    },
    ["runId", "stepId", "text"],
  ),
  tool(
    "workflow_accept_candidate",
    "Accept a manual-gate Agent Step candidate output and unlock downstream nodes.",
    {
      runId: stringProperty("Workflow Run ID"),
      stepId: stringProperty("Agent Step ID"),
    },
    ["runId", "stepId"],
  ),
  tool(
    "workflow_review_step",
    "Resolve a needs-review Agent Step after interruption or evidence review.",
    {
      runId: stringProperty("Workflow Run ID"),
      stepId: stringProperty("Agent Step ID"),
      action: { type: "string", enum: ["retry", "accept", "skip"] },
      output: {},
    },
    ["runId", "stepId", "action"],
  ),
  tool(
    "workflow_decide_approval",
    "Submit a JSON decision to an Approval Step.",
    {
      runId: stringProperty("Workflow Run ID"),
      stepId: stringProperty("Approval Step ID"),
      decision: {},
    },
    ["runId", "stepId", "decision"],
  ),
];

function stringProperty(description) {
  return { type: "string", description };
}

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function digest(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function withSourceLock(target, action) {
  const lockPath = `${target}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST")
      throw new Error(
        "Workflow source is already being edited; retry after the active write finishes",
      );
    throw error;
  }
  try {
    return await action();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function safeSourcePath(relative) {
  if (
    typeof relative !== "string" ||
    (isAbsolute(relative) && !relative.startsWith("~/.vibex/workflows/")) ||
    !relative.endsWith(".vibex-workflow.json")
  ) {
    throw new Error("path must end with .vibex-workflow.json");
  }
  const workspaceRoot = await realpath(process.cwd());
  const sharedPrefix = "~/.vibex/workflows/";
  const root = relative.startsWith(sharedPrefix)
    ? resolve(homedir(), ".vibex/workflows")
    : workspaceRoot;
  const target = relative.startsWith(sharedPrefix)
    ? resolve(root, relative.slice(sharedPrefix.length))
    : resolve(root, relative);
  const relation = relativePath(root, target);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("Workflow source escapes its authoring root");
  }
  return { root, target };
}

async function call(command, args) {
  if (!SERVER_URL || !SERVER_TOKEN) {
    throw new Error("VibeX Host did not inject its managed workflow gateway");
  }
  const response = await fetch(
    `${SERVER_URL}/api/v1/call/${encodeURIComponent(command)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${SERVER_TOKEN}`,
        "content-type": "application/json",
        "x-vibex-protocol-version": "1.0",
      },
      body: JSON.stringify({ operation_id: randomUUID(), args }),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      body.message || `${command} failed with HTTP ${response.status}`,
    );
  return body.data;
}

async function allEvents(runId) {
  const result = [];
  let afterSequence = 0;
  for (;;) {
    const page = await call("workflow_events", {
      runId,
      afterSequence,
      limit: 500,
    });
    result.push(...page);
    if (page.length < 500) return result;
    const next = Number(page.at(-1)?.sequence ?? afterSequence);
    if (next <= afterSequence) return result;
    afterSequence = next;
  }
}

async function execute(name, input) {
  switch (name) {
    case "workflow_source_read": {
      const { target } = await safeSourcePath(input.path);
      const content = await readFile(target, "utf8");
      if (Buffer.byteLength(content) > MAX_SOURCE_BYTES)
        throw new Error("Workflow source exceeds 4 MiB");
      return {
        path: input.path,
        definition: JSON.parse(content),
        revision: digest(content),
      };
    }
    case "workflow_source_write": {
      const { target } = await safeSourcePath(input.path);
      await call("workflow_validate", {
        request: { definition: input.definition },
      });
      const content = `${JSON.stringify(input.definition, null, 2)}\n`;
      if (Buffer.byteLength(content) > MAX_SOURCE_BYTES)
        throw new Error("Workflow source exceeds 4 MiB");
      await mkdir(dirname(target), { recursive: true });
      return withSourceLock(target, async () => {
        let current = null;
        try {
          current = await readFile(target, "utf8");
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        if (current !== null && !input.expectedRevision)
          throw new Error(
            "expectedRevision is required for an existing source",
          );
        if (current !== null && digest(current) !== input.expectedRevision)
          throw new Error(
            "Workflow source changed outside this Agent; read and reconcile it first",
          );
        if (current === null && input.expectedRevision)
          throw new Error("Workflow source was deleted outside this Agent");
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, content, { flag: "wx" });
          await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
        return { path: input.path, revision: digest(content) };
      });
    }
    case "workflow_validate":
      return call("workflow_validate", {
        request: { definition: input.definition },
      });
    case "workflow_publish":
      return call("workflow_publish", {
        request: {
          definition: input.definition,
          definitionId: input.definitionId ?? null,
          sourcePath: input.sourcePath,
        },
      });
    case "workflow_catalog":
      return input.definitionId
        ? call("workflow_versions", {
            definitionId: input.definitionId,
            limit: 100,
          })
        : call("workflow_list", { limit: 100 });
    case "workflow_run_inspect": {
      const run = await call("workflow_show", { runId: input.runId });
      const [version, steps, events] = await Promise.all([
        call("workflow_version", { versionId: run.definitionVersionId }),
        call("workflow_steps", { runId: input.runId }),
        allEvents(input.runId),
      ]);
      return {
        run,
        version,
        definition: JSON.parse(version.normalizedJson),
        steps,
        events,
      };
    }
    case "workflow_start":
      return call("workflow_start", {
        request: {
          definitionVersionId: input.definitionVersionId,
          workspaceId: input.workspaceId,
          input: input.input,
          policyOverride: input.policyOverride ?? null,
          debugStepId: input.debugStepId ?? null,
        },
      });
    case "workflow_debug_source":
      return call("workflow_debug", {
        request: {
          definition: input.definition,
          definitionId: input.definitionId ?? null,
          sourcePath: input.sourcePath,
          workspaceId: input.workspaceId ?? null,
          input: input.input ?? {},
          policyOverride: input.policyOverride ?? null,
          stepId: input.stepId,
          parentRunId: input.parentRunId ?? null,
          scope: input.scope ?? "node",
        },
      });
    case "workflow_debug_from_step":
      return call("workflow_fork", { request: input });
    case "workflow_pause_run":
      return call("workflow_pause", {
        request: { runId: input.runId, reason: input.reason ?? null },
      });
    case "workflow_cancel_run":
      return call("workflow_cancel", {
        request: { runId: input.runId, reason: input.reason ?? null },
      });
    case "workflow_resume_run":
      return call("workflow_resume_run", { request: { runId: input.runId } });
    case "workflow_pause_step":
      return call("workflow_pause_step", {
        request: {
          runId: input.runId,
          stepId: input.stepId,
          reason: input.reason ?? null,
        },
      });
    case "workflow_continue_step":
      return call("workflow_step_input", { request: input });
    case "workflow_accept_candidate":
      return call("workflow_accept_candidate", { request: input });
    case "workflow_review_step":
      return call("workflow_resume", {
        request: {
          runId: input.runId,
          decision: {
            kind: input.action,
            step_id: input.stepId,
            ...(input.action === "accept"
              ? { output: input.output ?? null }
              : {}),
          },
        },
      });
    case "workflow_decide_approval":
      return call("workflow_decide", { request: input });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function buildServer() {
  const server = new McpServer(
    { name: "vibex-workflow-mcp", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Edit source artifacts with CAS, publish immutable versions, and debug through durable Runs.",
    },
  );

  for (const definition of tools) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: fromJsonSchema(definition.inputSchema),
      },
      async (input) => {
        try {
          const result = await execute(definition.name, input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    );
  }

  return server;
}

serveStdio(buildServer, {
  legacy: "serve",
  onerror: (error) => process.stderr.write(`${error.message}\n`),
});
