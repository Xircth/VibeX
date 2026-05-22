import { readFile } from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';

const PROBE_OK = 'claude-agent-sdk-provider:ok';

function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function writeEventAsync(event) {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(event)}\n`, resolve);
  });
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function extractText(message) {
  const streamEvent = message?.type === 'stream_event' ? message.event : undefined;
  const streamDelta = streamEvent?.type === 'content_block_delta'
    ? streamEvent.delta
    : undefined;
  if (
    streamDelta?.type === 'text_delta' &&
    typeof streamDelta.text === 'string'
  ) {
    return streamDelta.text;
  }

  const content = message?.message?.content ?? message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        if (block?.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
        if (typeof block?.text === 'string') {
          return block.text;
        }
        return '';
      })
      .join('');
    return text || undefined;
  }
  if (typeof message?.result === 'string') {
    return message.result;
  }
  return undefined;
}

function toPermissionMode(value) {
  switch (value) {
    case 'default':
    case 'acceptEdits':
    case 'bypassPermissions':
    case 'plan':
    case 'dontAsk':
    case 'auto':
      return value;
    default:
      return undefined;
  }
}

function toEffort(value) {
  switch (value) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value;
    case 'extra_high':
      return 'xhigh';
    default:
      return undefined;
  }
}

function buildContent(input) {
  const content = [];
  if (typeof input.text === 'string' && input.text.length > 0) {
    content.push({ type: 'text', text: input.text });
  }
  for (const image of input.images ?? []) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType,
        data: image.base64,
      },
    });
  }
  return content.length > 0 ? content : [{ type: 'text', text: '' }];
}

function buildOptions(input) {
  const permissionMode = toPermissionMode(input.permissionMode);
  const profileEnv =
    input.env && typeof input.env === 'object' && !Array.isArray(input.env)
      ? Object.fromEntries(
          Object.entries(input.env).filter(
            ([, value]) => typeof value === 'string'
          )
        )
      : {};

  Object.assign(process.env, profileEnv, {
    CLAUDE_AGENT_SDK_CLIENT_APP:
      process.env.CLAUDE_AGENT_SDK_CLIENT_APP ??
      'vibex/claude-native-provider',
  });

  const options = {
    cwd: readString(input.cwd),
    includePartialMessages: true,
    includeHookEvents: true,
  };

  const model = readString(input.model);
  if (model) options.model = model;

  const effort = toEffort(readString(input.effort));
  if (effort) options.effort = effort;

  if (permissionMode) {
    options.permissionMode = permissionMode;
    if (permissionMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true;
    }
  }

  const resume = readString(input.threadId) ?? readString(input.resume);
  if (resume) options.resume = resume;

  const sessionId = readString(input.sessionId);
  const forkSession = readBoolean(input.forkSession);
  if (forkSession !== undefined) options.forkSession = forkSession;
  if (sessionId && (!resume || forkSession)) options.sessionId = sessionId;

  return options;
}

async function* promptFromInput(input) {
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: buildContent(input),
    },
  };
}

function slashCommand(input) {
  if (Array.isArray(input.images) && input.images.length > 0) {
    return undefined;
  }
  const text = String(input.text ?? '');
  const match = text.match(/^\s*\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?\s*$/);
  if (!match) {
    return undefined;
  }
  return {
    command: match[1],
    arguments: match[2] ?? '',
    raw: text.trim(),
  };
}

function promptForInput(input, command) {
  return command ? command.raw : promptFromInput(input);
}

async function readInputJson(inputPath) {
  return JSON.parse((await readFile(inputPath, 'utf8')).replace(/^\uFEFF/, ''));
}

async function emitContextUsage(agent, input) {
  if (typeof agent?.getContextUsage !== 'function') {
    return;
  }

  try {
    const contextUsage = await agent.getContextUsage();
    await writeEventAsync({
      type: 'sdk_context_usage',
      session_id: input.threadId ?? input.sessionId,
      contextUsage,
    });
  } catch (error) {
    await writeEventAsync({
      type: 'sdk_context_usage_error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

async function run(inputPath) {
  const input = await readInputJson(inputPath);
  const options = buildOptions(input);
  const command = slashCommand(input);
  const prompt = promptForInput(input, command);
  const agent = query({ prompt, options });

  for await (const message of agent) {
    const text = extractText(message);
    writeEvent({
      type: 'sdk_event',
      text,
      session_id: message?.session_id ?? message?.sessionId,
      uuid: message?.uuid,
      event: message,
    });
  }

  await emitContextUsage(agent, input);
}

async function writeMetadata(inputPath) {
  const input = await readInputJson(inputPath);
  const agent = query({
    prompt: ' ',
    options: {
      ...buildOptions(input),
      maxTurns: 1,
    },
  });
  try {
    const metadata = await agent.initializationResult();
    await writeEventAsync({
      type: 'sdk_metadata',
      commands: metadata.commands ?? [],
      models: metadata.models ?? [],
    });
  } finally {
    agent.close();
  }
}

if (process.argv.includes('--probe')) {
  process.stdout.write(`${PROBE_OK}\n`);
  process.exit(0);
}

if (process.argv[2] === '--metadata') {
  const metadataInputPath = process.argv[3];
  if (!metadataInputPath) {
    await writeEventAsync({
      type: 'sdk_error',
      message: 'Missing Claude Agent SDK metadata input path.',
    });
    process.exit(2);
  }

  try {
    await writeMetadata(metadataInputPath);
  } catch (error) {
    await writeEventAsync({
      type: 'sdk_error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
  process.exit(0);
}

const inputPath = process.argv[2];
if (!inputPath) {
  writeEvent({
    type: 'sdk_error',
    message: 'Missing Claude Agent SDK bridge input path.',
  });
  process.exit(2);
}

try {
  await run(inputPath);
} catch (error) {
  writeEvent({
    type: 'sdk_error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
}
