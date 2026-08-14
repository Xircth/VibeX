const fs = require('fs');

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function parseArgs(argv) {
  const [resource, action, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      index += 1;
    }
  }
  return { resource, action, flags };
}

function required(flags, key) {
  const value = flags[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required --${key}`);
  }
  return value;
}

function jsonFile(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function operationId(flags) {
  return typeof flags['operation-id'] === 'string'
    ? flags['operation-id']
    : crypto.randomUUID();
}

async function call(command, args, flags) {
  const baseUrl = (process.env.VIBEX_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '');
  const token = process.env.VIBEX_TOKEN;
  if (!token) throw new Error('VIBEX_TOKEN is required');
  const response = await fetch(`${baseUrl}/api/v1/call/${encodeURIComponent(command)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-vibex-protocol-version': '1.0',
    },
    body: JSON.stringify({ operation_id: operationId(flags), args }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${body.code || response.status}: ${body.message || response.statusText}`);
  }
  return body.data;
}

function print(value, flags) {
  if (flags.json || typeof value !== 'string') {
    process.stdout.write(`${JSON.stringify(value, null, flags.json ? 0 : 2)}\n`);
  } else {
    process.stdout.write(`${value}\n`);
  }
}

async function waitFor(read, status, flags) {
  const timeoutSeconds = Number(flags.timeout || 600);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (true) {
    const value = await read();
    const current = status(value);
    if (current && TERMINAL.has(current)) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutSeconds}s`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function conversation(action, flags) {
  if (action === 'create') {
    return call(
      'conversation_create',
      {
        workspaceId: required(flags, 'workspace'),
        agentId: required(flags, 'agent'),
        title: flags.title || null,
        initialPrompt: flags.prompt || null,
      },
      flags
    );
  }
  if (action === 'child' || action === 'fork') {
    return call(
      'conversation_child_create',
      {
        request: {
          parentConversationId: required(flags, 'parent'),
          agentId: required(flags, 'agent'),
          title: flags.title || null,
          initialPrompt: flags.prompt || null,
          visible: !flags.hidden,
        },
      },
      flags
    );
  }
  if (action === 'send') {
    return call(
      'conversation_input_submit',
      {
        request: {
          conversationId: required(flags, 'conversation'),
          payload: {
            agentId: required(flags, 'agent'),
            workspaceId: required(flags, 'workspace'),
            text: required(flags, 'text'),
            images: [],
            configOverrides: [],
            pluginActions: [],
          },
        },
      },
      flags
    );
  }
  if (action === 'steer') {
    return call(
      'conversation_steer',
      {
        request: {
          conversationId: required(flags, 'conversation'),
          expectedTurnId: required(flags, 'turn'),
          text: required(flags, 'text'),
          images: [],
        },
      },
      flags
    );
  }
  if (action === 'show' || action === 'output') {
    return call(
      'conversation_output',
      { conversationId: required(flags, 'conversation') },
      flags
    );
  }
  if (action === 'relations') {
    return call(
      'conversation_relation_list',
      { request: { conversationId: required(flags, 'conversation') } },
      flags
    );
  }
  if (action === 'wait') {
    const conversationId = required(flags, 'conversation');
    return waitFor(
      () => call('conversation_output', { conversationId }, flags),
      (value) => value.turn && value.turn.status,
      flags
    );
  }
  if (action === 'cancel') {
    return call(
      'conversation_cancel_turn',
      { request: { conversationId: required(flags, 'conversation'), reason: flags.reason || null } },
      flags
    );
  }
  throw new Error(`Unknown conversation action: ${action || '<missing>'}`);
}

async function workflow(action, flags) {
  if (action === 'validate') {
    return call(
      'workflow_validate',
      { request: { definition: jsonFile(required(flags, 'file')) } },
      flags
    );
  }
  if (action === 'publish') {
    return call(
      'workflow_publish',
      {
        request: {
          definitionId: flags['definition-id'] || null,
          definition: jsonFile(required(flags, 'file')),
        },
      },
      flags
    );
  }
  if (action === 'run') {
    return call(
      'workflow_start',
      {
        request: {
          definitionVersionId: required(flags, 'version'),
          workspaceId: required(flags, 'workspace'),
          input: flags.input ? jsonFile(flags.input) : {},
          policyOverride: flags.policy ? jsonFile(flags.policy) : null,
        },
      },
      flags
    );
  }
  if (action === 'show') {
    const runId = required(flags, 'run');
    const [run, steps, events] = await Promise.all([
      call('workflow_show', { runId }, flags),
      call('workflow_steps', { runId }, flags),
      call('workflow_events', { runId, afterSequence: 0, limit: 1000 }, flags),
    ]);
    return { run, steps, events };
  }
  if (action === 'wait') {
    const runId = required(flags, 'run');
    return waitFor(
      () => call('workflow_show', { runId }, flags),
      (value) => value.status,
      flags
    );
  }
  if (action === 'history') {
    return call(
      'workflow_events',
      {
        runId: required(flags, 'run'),
        afterSequence: Number(flags.after || 0),
        limit: Number(flags.limit || 1000),
      },
      flags
    );
  }
  if (action === 'cancel') {
    return call(
      'workflow_cancel',
      { request: { runId: required(flags, 'run'), reason: flags.reason || null } },
      flags
    );
  }
  if (action === 'resume') {
    const kind = required(flags, 'decision');
    const decision =
      kind === 'cancel'
        ? { kind, reason: flags.reason || null }
        : {
            kind,
            step_id: required(flags, 'step'),
            ...(kind === 'accept' && flags.output ? { output: jsonFile(flags.output) } : {}),
          };
    return call(
      'workflow_resume',
      { request: { runId: required(flags, 'run'), decision } },
      flags
    );
  }
  throw new Error(`Unknown workflow action: ${action || '<missing>'}`);
}

async function run(argv) {
  const { resource, action, flags } = parseArgs(argv);
  const result = resource === 'conversation'
    ? await conversation(action, flags)
    : await workflow(action, flags);
  print(result, flags);
}

module.exports = { run, parseArgs };
