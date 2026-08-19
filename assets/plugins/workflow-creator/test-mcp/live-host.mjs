#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const SERVER_NAME = "vibex.workflow-creator.vibex-workflow-mcp";
const SOURCE_PATH =
  "~/.vibex/workflows/vibex-full-repository-review.vibex-workflow.json";
const CONFIG_PATH = resolve(homedir(), ".codex/config.toml");

function readString(value) {
  return JSON.parse(value.trim());
}

function managedServerConfig(content) {
  const escaped = SERVER_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const section = new RegExp(
    `\\[mcp_servers\\."${escaped}"\\]([\\s\\S]*?)(?=\\n\\[|$)`,
  ).exec(content)?.[1];
  const envSection = new RegExp(
    `\\[mcp_servers\\."${escaped}"\\.env\\]([\\s\\S]*?)(?=\\n\\[|$)`,
  ).exec(content)?.[1];
  if (!section || !envSection) {
    throw new Error(`Managed MCP ${SERVER_NAME} is not configured in Codex`);
  }
  const command = /^command\s*=\s*(.+)$/m.exec(section)?.[1];
  const args = /^args\s*=\s*(.+)$/m.exec(section)?.[1];
  if (!command || !args) throw new Error("Managed MCP command is incomplete");

  const env = {};
  for (const match of envSection.matchAll(/^([A-Z0-9_]+)\s*=\s*(.+)$/gm)) {
    env[match[1]] = readString(match[2]);
  }
  return { command: readString(command), args: JSON.parse(args), env };
}

function resultOf(response) {
  if (response.isError) {
    throw new Error(response.content?.[0]?.text || "MCP tool failed");
  }
  if (response.structuredContent) return response.structuredContent;
  return JSON.parse(response.content?.[0]?.text ?? "null");
}

async function openClient() {
  const managed = managedServerConfig(await readFile(CONFIG_PATH, "utf8"));
  const client = new Client(
    { name: "vibex-workflow-live-verification", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StdioClientTransport({
      command: managed.command,
      args: managed.args,
      cwd: "/Users/mac/Projects/VibeX",
      env: { ...process.env, ...managed.env },
      stderr: "pipe",
    }),
  );
  return client;
}

async function tool(client, name, args) {
  return resultOf(await client.callTool({ name, arguments: args }));
}

async function provision(client, workspaceId) {
  const source = await tool(client, "workflow_source_read", {
    path: SOURCE_PATH,
  });
  const written = await tool(client, "workflow_source_write", {
    path: SOURCE_PATH,
    definition: source.definition,
    expectedRevision: source.revision,
  });
  const validation = await tool(client, "workflow_validate", {
    definition: source.definition,
  });
  const published = await tool(client, "workflow_publish", {
    definition: source.definition,
    sourcePath: SOURCE_PATH,
  });
  const catalog = await tool(client, "workflow_catalog", {});
  const started = await tool(client, "workflow_start", {
    definitionVersionId: published.id,
    workspaceId,
    input: {
      reviewFocus:
        "全仓正确性、Workflow/Automation、Agent 原生会话配置、MCP 与插件平台",
    },
  });
  console.log(
    JSON.stringify(
      {
        protocol: client.getNegotiatedProtocolVersion(),
        sourceRevision: written.revision,
        validation,
        definitionId: published.definitionId,
        definitionVersionId: published.id,
        catalogContainsDefinition: catalog.some(
          (entry) => entry.id === published.definitionId,
        ),
        runId: started.id,
        runStatus: started.status,
      },
      null,
      2,
    ),
  );
}

async function publishReviewRuntime(client) {
  const source = await tool(client, "workflow_source_read", {
    path: SOURCE_PATH,
  });
  const definition = {
    ...source.definition,
    steps: source.definition.steps.map((step) =>
      step.kind === "agent"
        ? {
            ...step,
            prompt: [
              "backend-correctness-review",
              "adversarial-synthesis",
            ].includes(step.id)
              ? `Do not edit, create, delete, format, or generate any repository file. This is a report-only review.\n\n${step.prompt.replace(/^Do not edit[^\n]*\n\n/, "")}`
              : step.prompt,
            configOverrides: {
              ...step.configOverrides,
              mode: [
                "backend-correctness-review",
                "adversarial-synthesis",
              ].includes(step.id)
                ? "agent"
                : "agent-full-access",
            },
          }
        : step,
    ),
  };
  const written = await tool(client, "workflow_source_write", {
    path: SOURCE_PATH,
    definition,
    expectedRevision: source.revision,
  });
  const published = await tool(client, "workflow_publish", {
    definition,
    sourcePath: SOURCE_PATH,
  });
  console.log(
    JSON.stringify(
      {
        sourceRevision: written.revision,
        definitionId: published.definitionId,
        definitionVersionId: published.id,
        version: published.version,
      },
      null,
      2,
    ),
  );
}

async function inspect(client, runId) {
  const result = await tool(client, "workflow_run_inspect", { runId });
  console.log(
    JSON.stringify(
      {
        run: result.run,
        steps: result.steps.map((step) => ({
          stepId: step.stepId,
          attempt: step.attempt,
          status: step.status,
          awaitingAcceptance: step.awaitingAcceptance,
          awaitingInput: step.awaitingInput,
          conversationId: step.conversationId,
          candidateOutput: step.candidateOutputJson,
          acceptedOutput: step.outputJson,
          lastError: step.lastError,
        })),
        eventCount: result.events.length,
        lastEvents: result.events.slice(-8),
      },
      null,
      2,
    ),
  );
}

async function status(client, runId) {
  const result = await tool(client, "workflow_run_inspect", { runId });
  console.log(
    JSON.stringify(
      {
        runId,
        status: result.run.status,
        controlState: result.run.controlState,
        agentCallsStarted: result.run.agentCallsStarted,
        eventCount: result.events.length,
        steps: result.steps.map((step) => ({
          stepId: step.stepId,
          attempt: step.attempt,
          status: step.status,
          awaitingInput: step.awaitingInput,
          awaitingAcceptance: step.awaitingAcceptance,
          hasCandidate: step.candidateOutputJson != null,
          hasOutput: step.outputJson != null,
          lastError: step.lastError,
        })),
      },
      null,
      2,
    ),
  );
}

async function action(client, name, runId, stepId, text) {
  const argumentsByTool = {
    workflow_accept_candidate: { runId, stepId },
    workflow_review_step: {
      runId,
      stepId,
      action: text || "retry",
    },
    workflow_pause_step: { runId, stepId, reason: text || "Live MCP test" },
    workflow_continue_step: {
      runId,
      stepId,
      text: text || "请继续完成本节点，并保持证据可核验。",
    },
    workflow_pause_run: { runId, reason: text || "Live MCP test" },
    workflow_resume_run: { runId },
    workflow_cancel_run: { runId, reason: text || "Live MCP test cleanup" },
  };
  const args = argumentsByTool[name];
  if (!args) throw new Error(`Unsupported live action: ${name}`);
  console.log(JSON.stringify(await tool(client, name, args), null, 2));
}

async function fork(client, parentRunId, definitionVersionId, stepId, scope) {
  console.log(
    JSON.stringify(
      await tool(client, "workflow_debug_from_step", {
        parentRunId,
        definitionVersionId,
        stepId,
        scope: scope || "downstream",
      }),
      null,
      2,
    ),
  );
}

async function startDebug(client, definitionVersionId, workspaceId, stepId) {
  console.log(
    JSON.stringify(
      await tool(client, "workflow_start", {
        definitionVersionId,
        workspaceId,
        input: {
          purpose: "MCP initial node debug verification",
          reviewFocus: "Frontend Workflow Studio initial node debug semantics",
        },
        debugStepId: stepId,
      }),
      null,
      2,
    ),
  );
}

async function debugSource(client, workspaceId, stepId) {
  const source = await tool(client, "workflow_source_read", {
    path: SOURCE_PATH,
  });
  const path =
    "~/.vibex/workflows/vibex-mcp-unpublished-debug.vibex-workflow.json";
  const definition = {
    ...source.definition,
    name: "VibeX MCP unpublished debug boundary",
  };
  let expectedRevision;
  try {
    expectedRevision = (
      await tool(client, "workflow_source_read", { path })
    ).revision;
  } catch {
    expectedRevision = undefined;
  }
  await tool(client, "workflow_source_write", {
    path,
    definition,
    ...(expectedRevision ? { expectedRevision } : {}),
  });
  const before = await tool(client, "workflow_catalog", {});
  const run = await tool(client, "workflow_debug_source", {
    definition,
    sourcePath: path,
    workspaceId,
    input: {
      purpose: "Verify unpublished MCP source debugging",
      reviewFocus: "Workflow debug source isolation and MCP parity",
    },
    stepId,
    scope: "node",
  });
  const inspected = await tool(client, "workflow_run_inspect", {
    runId: run.id,
  });
  const after = await tool(client, "workflow_catalog", {});
  console.log(
    JSON.stringify(
      {
        runId: run.id,
        runMode: run.runMode,
        definitionVersion: inspected.version.version,
        catalogCountBefore: before.length,
        catalogCountAfter: after.length,
        hiddenFromPublishedCatalog: before.length === after.length,
      },
      null,
      2,
    ),
  );
}

const [command, ...args] = process.argv.slice(2);
const client = await openClient();
try {
  if (command === "provision") await provision(client, args[0]);
  else if (command === "publish-review-runtime")
    await publishReviewRuntime(client);
  else if (command === "inspect") await inspect(client, args[0]);
  else if (command === "status") await status(client, args[0]);
  else if (command === "action")
    await action(client, args[0], args[1], args[2], args.slice(3).join(" "));
  else if (command === "fork")
    await fork(client, args[0], args[1], args[2], args[3]);
  else if (command === "start-debug")
    await startDebug(client, args[0], args[1], args[2]);
  else if (command === "debug-source")
    await debugSource(client, args[0], args[1]);
  else {
    throw new Error(
      "Usage: live-host.mjs provision <workspace-id> | publish-review-runtime | inspect/status <run-id> | action <tool> <run-id> [step-id] [text] | fork <parent-run-id> <definition-version-id> <step-id> [node|downstream] | start-debug <definition-version-id> <workspace-id> <step-id> | debug-source <workspace-id> <step-id>",
    );
  }
} finally {
  await client.close();
}
