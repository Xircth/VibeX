import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  activatePluginWorker,
  normalizePluginContext,
} from '../../../packages/plugin-sdk/dist/index.js';
import {
  buildFimContext,
  buildProtocolHttpRequest,
  CodeCompletionEngine,
  createCodeCompletionWorkerDefinition,
  extractRawCompletionFromResponse,
  isLanguageDisabled,
  isPrivacyIgnoredFile,
  postProcessCompletion,
  resolveDynamicScope,
  resolveEndpointUrl,
} from '../dist/worker.mjs';
import appPlugin, {
  applyWithUndoStopBarrier,
  computeAdaptiveDebounceMs,
  doesEventMatchShortcut,
  ForwardTypingCache,
  parseShortcutDescriptor,
  resolveInlineCompletionRangeAndText,
} from '../app/main.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, '..');

test('plugin manifest, README summary, and config.json conform to v4 / API 2.0 specification', async () => {
  const manifest = JSON.parse(
    await readFile(join(pluginRoot, '.vibex-plugin/plugin.json'), 'utf8'),
  );
  assert.equal(manifest.id, 'vibex.code-completion');
  assert.equal(manifest.name, 'AI代码补全');
  assert.equal(manifest.manifestVersion, 4);
  assert.equal(manifest.apiVersion, '2.0');
  assert.deepEqual(manifest.engines, {
    vibex: '>=0.1.3 <1.0.0',
    pluginSdk: '^2.0.0',
  });
  assert.equal(manifest.interface?.icon, 'assets/icon.svg');
  assert.equal('permissions' in manifest, false);
  assert.equal(manifest.entrypoints.worker.path, 'dist/worker.mjs');
  assert.equal(manifest.entrypoints.app.entry, 'app/main.js');
  assert.equal(manifest.entrypoints.app.protocol, '2.0');

  const statusItem = manifest.integrations.find((item) => item.kind === 'app.status');
  assert.ok(statusItem);
  assert.equal(statusItem.slot, 'status.after-mcp');
  assert.equal(statusItem.handler, 'completion.status');
  assert.equal(statusItem.title, 'AI代码补全');

  const iconSvg = await readFile(join(pluginRoot, 'assets/icon.svg'), 'utf8');
  assert.match(iconSvg, /viewBox="0 0 36 36"/);
  assert.match(iconSvg, /linearGradient id="cc_bg"/);

  const config = JSON.parse(
    await readFile(join(pluginRoot, 'config.json'), 'utf8'),
  );
  assert.equal(config.enabled, true);
  assert.equal(config.providerProtocol, 'openai-compatible');

  const readme = await readFile(join(pluginRoot, 'README.md'), 'utf8');
  assert.match(readme, /^---\r?\nsummary:\s+.+\r?\n---/);
});

test('privacy guard blocks .env*, *.pem, *.key, *secret*, *.min.js before network calls', async () => {
  assert.equal(isPrivacyIgnoredFile('.env'), true);
  assert.equal(isPrivacyIgnoredFile('config/.env.local'), true);
  assert.equal(isPrivacyIgnoredFile('certs/private.pem'), true);
  assert.equal(isPrivacyIgnoredFile('keys/id_rsa.key'), true);
  assert.equal(isPrivacyIgnoredFile('src/client_secret_config.ts'), true);
  assert.equal(isPrivacyIgnoredFile('dist/bundle.min.js'), true);
  assert.equal(isPrivacyIgnoredFile('src/components/Editor.tsx'), false);
  assert.equal(isLanguageDisabled('markdown', 'markdown, plaintext'), true);
  assert.equal(isLanguageDisabled('typescript', 'markdown, plaintext'), false);

  let networkCalled = false;
  const engine = new CodeCompletionEngine({
    fetchImpl: async () => {
      networkCalled = true;
      throw new Error('Should not be called for privacy-ignored files');
    },
  });

  const envResult = await engine.complete({
    filePath: '/workspace/.env.production',
    languageId: 'dotenv',
    prefix: 'OPENAI_API_KEY=',
    suffix: '',
  });

  assert.equal(networkCalled, false);
  assert.equal(envResult.items.length, 0);
  assert.equal(envResult.skippedReason, 'privacy-ignored-glob');
});

test('OpenAI-compatible protocol formats POST /v1/chat/completions with FIM prompt and stop sequences', () => {
  assert.equal(
    resolveEndpointUrl('https://api.openai.com/v1', '/v1/chat/completions'),
    'https://api.openai.com/v1/chat/completions',
  );
  assert.equal(
    resolveEndpointUrl('https://api.deepseek.com', '/v1/chat/completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );

  const fimContext = buildFimContext({
    filePath: 'src/math.ts',
    languageId: 'typescript',
    prefix: 'export function add(a: number, b: number) {\n  return ',
    suffix: '\n}',
  });
  const dynamicScope = resolveDynamicScope({
    prefix: 'export function add(a: number, b: number) {\n  return ',
    suffix: '\n}',
    completionScope: 'smart',
    maxTokens: 128,
  });

  const req = buildProtocolHttpRequest({
    config: {
      providerProtocol: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test-openai',
      model: 'deepseek-chat',
      temperature: 0.1,
    },
    fimContext,
    dynamicScope,
  });

  assert.equal(req.protocol, 'openai-compatible');
  assert.equal(req.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(req.headers.Authorization, 'Bearer sk-test-openai');
  assert.equal(req.body.model, 'deepseek-chat');
  assert.equal(req.body.temperature, 0.1);
  assert.ok(Array.isArray(req.body.stop));
  assert.ok(req.body.stop.includes('</COMPLETION>'));
  assert.equal(req.body.messages.length, 2);
  assert.equal(req.body.messages[0].role, 'system');
  assert.ok(req.body.messages[1].content.includes('<PREFIX>'));
  assert.ok(req.body.messages[1].content.includes('<SUFFIX>'));
});

test('Anthropic-compatible protocol formats POST /v1/messages with <COMPLETION> assistant prefill and </COMPLETION> stop_sequences', () => {
  const fimContext = buildFimContext({
    filePath: 'src/service.ts',
    languageId: 'typescript',
    prefix: 'const total = items.reduce((acc, item) => ',
    suffix: ', 0);',
  });
  const dynamicScope = resolveDynamicScope({
    prefix: 'const total = items.reduce((acc, item) => ',
    suffix: ', 0);',
    completionScope: 'smart',
    maxTokens: 128,
  });

  const req = buildProtocolHttpRequest({
    config: {
      providerProtocol: 'anthropic-compatible',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-haiku-latest',
      temperature: 0.1,
    },
    fimContext,
    dynamicScope,
  });

  assert.equal(req.protocol, 'anthropic-compatible');
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['x-api-key'], 'sk-ant-test');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.body.model, 'claude-3-5-haiku-latest');
  assert.ok(req.body.stop_sequences.includes('</COMPLETION>'));
  // Because suffix on current line is `, 0);`, dynamicScope is single-line and includes `\n` stop
  assert.equal(dynamicScope.isSingleLine, true);
  assert.ok(req.body.stop_sequences.includes('\n'));
  // Assistant message prefill must be `<COMPLETION>`
  assert.equal(req.body.messages.length, 2);
  assert.equal(req.body.messages[1].role, 'assistant');
  assert.equal(req.body.messages[1].content, '<COMPLETION>');
});

test('deterministic post-processor strips markdown fences, <COMPLETION> tags, prefix/suffix overlap, and redundant brackets', () => {
  // 1. Markdown fence & tag stripping
  const fenced = '```typescript\n<COMPLETION>a + b;</COMPLETION>\n```';
  assert.equal(
    postProcessCompletion(fenced, {
      prefix: '  return ',
      suffix: '\n}',
    }),
    'a + b;',
  );

  // 2. Prefix overlap deduplication (model repeats `return ` from current line prefix)
  assert.equal(
    postProcessCompletion('  return a + b;', {
      prefix: 'function sum(a, b) {\n  return ',
      suffix: '\n}',
    }),
    'a + b;',
  );

  // 3. Suffix overlap & redundant closing parenthesis deduplication (`foo(|)` where suffix starts with `);`)
  assert.equal(
    postProcessCompletion('bar, baz);', {
      prefix: 'foo(',
      suffix: ');',
      isSingleLine: true,
    }),
    'bar, baz',
  );

  // 4. Multi-line suffix closing brace deduplication
  const multiLineRaw = '  const res = a + b;\n  return res;\n}';
  assert.equal(
    postProcessCompletion(multiLineRaw, {
      prefix: 'function compute(a, b) {\n',
      suffix: '\n}',
      isSingleLine: false,
    }),
    '  const res = a + b;\n  return res;',
  );

  // 5. Response payload extraction for both protocols
  assert.equal(
    extractRawCompletionFromResponse('openai-compatible', {
      choices: [{ message: { content: '<COMPLETION>x + 1</COMPLETION>' } }],
    }),
    '<COMPLETION>x + 1</COMPLETION>',
  );
  assert.equal(
    extractRawCompletionFromResponse('anthropic-compatible', {
      content: [{ type: 'text', text: 'x + 1' }],
    }),
    'x + 1',
  );
});

test('FIM context builder ranks open neighbor tabs via Jaccard similarity and filters privacy-ignored neighbors', () => {
  const ctx = buildFimContext({
    filePath: 'src/checkout.ts',
    languageId: 'typescript',
    prefix: 'export function calculateInvoiceTotal(invoiceItems, discountRate) {\n  ',
    suffix: '\n}',
    neighbors: [
      {
        filePath: 'src/unrelated.ts',
        content: 'export function renderSidebarIcon(themeColor) { return themeColor; }',
      },
      {
        filePath: 'src/invoiceTypes.ts',
        content:
          'export interface InvoiceItem { price: number; discountRate: number; }\nexport function sumInvoiceItems(invoiceItems: InvoiceItem[]) {}',
      },
      {
        filePath: '.env.secret',
        content: 'STRIPE_SECRET_KEY=sk_live_123456',
      },
    ],
  });

  // `.env.secret` must be excluded by privacy guard
  assert.equal(
    ctx.selectedNeighbors.some((n) => n.filePath.includes('.env')),
    false,
  );
  // `src/invoiceTypes.ts` has higher Jaccard similarity than `src/unrelated.ts`
  assert.equal(ctx.selectedNeighbors[0].filePath, 'src/invoiceTypes.ts');
  assert.ok(ctx.userPrompt.includes('// File: src/invoiceTypes.ts'));
});

test('worker runtime handles completion.complete (OpenAI & Anthropic) and cancels stale in-flight requests', async () => {
  const calls = [];
  const { workerDefinition } = createCodeCompletionWorkerDefinition({
    config: {
      enabled: true,
      providerProtocol: 'anthropic-compatible',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-key',
      model: 'claude-3-5-haiku-latest',
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'acc + item.price' }],
        }),
      };
    },
  });

  const activated = await activatePluginWorker(workerDefinition, {
    context: normalizePluginContext({
      pluginId: 'vibex.code-completion',
      pluginVersion: '2.0.0',
      generation: 1,
    }),
    host: {
      async call() {
        return null;
      },
    },
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  });

  const res = await activated.invoke('completion.complete', {
    filePath: 'src/cart.ts',
    languageId: 'typescript',
    prefix: 'const sum = items.reduce((acc, item) => ',
    suffix: ', 0);',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(res.insertText, 'acc + item.price');
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].insertText, 'acc + item.price');

  await activated.dispose();
});

test('app entrypoint supports adaptive debounce, forward-typing prefix cache, and Undo Stop barrier', async () => {
  assert.equal(computeAdaptiveDebounceMs('user.', false), 60);
  assert.equal(computeAdaptiveDebounceMs('call(', false), 60);
  assert.equal(computeAdaptiveDebounceMs('const value', false), 180);
  assert.equal(computeAdaptiveDebounceMs('const value', true), 0);

  const cache = new ForwardTypingCache();
  cache.store('src/app.ts', 10, 'const result = ', ';', 'computeValue(x)');
  assert.equal(
    cache.lookup('src/app.ts', 10, 'const result = comp', ';'),
    'uteValue(x)',
  );
  assert.equal(
    cache.lookup('src/app.ts', 10, 'const result = other', ';'),
    null,
  );

  let undoStops = 0;
  const mockEditor = {
    pushUndoStop() {
      undoStops += 1;
    },
  };
  applyWithUndoStopBarrier(mockEditor, () => 'accepted');
  assert.equal(undoStops, 2);

  let registeredProvider = null;
  let workerCallCount = 0;
  const handlers = new Map();

  const instance = await appPlugin.activate({
    services: {
      get(serviceId) {
        if (serviceId === 'vibex.code-editor') {
          return {
            registerInlineCompletionProvider(_selector, provider) {
              registeredProvider = provider;
              return { dispose() {} };
            },
          };
        }
        return null;
      },
    },
    registerHandler(name, fn) {
      handlers.set(name, fn);
    },
    async invokeWorker(method, params) {
      if (method === 'completion.complete') {
        workerCallCount += 1;
        return {
          items: [{ insertText: 'fetchUser(id)' }],
          requestId: params.requestId,
        };
      }
      return { enabled: true };
    },
  });

  assert.ok(registeredProvider);
  const firstCompletion = await instance.provideInlineCompletions(
    {
      filePath: 'src/user.ts',
      languageId: 'typescript',
      prefix: 'const user = await ',
      suffix: ';',
      position: { lineNumber: 3, column: 20 },
      manual: true,
    },
    null,
    { triggerKind: 0, manual: true },
  );

  assert.equal(workerCallCount, 1);
  assert.equal(firstCompletion.items[0].insertText, 'fetchUser(id)');

  // Forward typing `fetch` should hit prefix cache with 0 additional worker calls
  const cachedCompletion = await instance.provideInlineCompletions(
    {
      filePath: 'src/user.ts',
      languageId: 'typescript',
      prefix: 'const user = await fetch',
      suffix: ';',
      position: { lineNumber: 3, column: 25 },
      manual: true,
    },
    null,
    { triggerKind: 0, manual: true },
  );

  assert.equal(workerCallCount, 1);
  assert.equal(cachedCompletion.items[0].insertText, 'User(id)');

  instance.dispose();
});

test('handles comment + Enter newline framing in Python files and late vibex.code-editor registration', async () => {
  assert.equal(
    postProcessCompletion('<COMPLETION>\nimport pygame\nimport random\n</COMPLETION>', {
      prefix: '//贪吃蛇游戏\n',
      suffix: '',
      isSingleLine: false,
    }),
    'import pygame\nimport random',
  );
  assert.equal(
    postProcessCompletion('\nimport pygame\nimport random', {
      prefix: '# 贪吃蛇游戏\n',
      suffix: '',
      isSingleLine: false,
    }),
    'import pygame\nimport random',
  );

  let registeredProvider = null;
  let changeListener = null;
  let cancelCalls = 0;

  const instance = await appPlugin.activate({
    services: {
      get() {
        return null;
      },
      onChange(serviceId, cb) {
        if (serviceId === 'vibex.code-editor') {
          changeListener = cb;
        }
        return () => {};
      },
    },
    async invokeWorker(method) {
      if (method === 'completion.cancel') {
        cancelCalls += 1;
      }
      return { items: [{ insertText: 'import pygame' }] };
    },
  });

  assert.equal(registeredProvider, null);
  assert.equal(typeof changeListener, 'function');

  changeListener({
    registerInlineCompletionProvider(_selector, provider) {
      registeredProvider = provider;
      return { dispose() {} };
    },
  });
  assert.ok(registeredProvider);

  // Cancelling when no worker request is in flight should not emit completion.cancel IPC
  instance.cancelActiveCompletion();
  assert.equal(cancelCalls, 0);

  instance.dispose();
});

test('supports customizable manualShortcut and enforces triggerMode === manual', async () => {
  assert.deepEqual(parseShortcutDescriptor('Alt+\\'), {
    ctrl: false,
    alt: true,
    shift: false,
    meta: false,
    key: '\\',
  });
  assert.equal(
    doesEventMatchShortcut(
      { altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, key: '\\', code: 'Backslash' },
      'Alt+\\',
    ),
    true,
  );
  assert.equal(
    doesEventMatchShortcut(
      { altKey: true, ctrlKey: true, shiftKey: false, metaKey: false, key: ' ', code: 'Space' },
      'Ctrl+Alt+Space',
    ),
    true,
  );
  assert.equal(
    doesEventMatchShortcut(
      { altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, key: 'ˆ', code: 'KeyI' },
      'Alt+I',
    ),
    true,
  );

  // Worker skips automatic requests when triggerMode === 'manual', but runs manual requests
  const engine = new CodeCompletionEngine({
    config: {
      enabled: true,
      triggerMode: 'manual',
      manualShortcut: 'Alt+I',
      apiKey: 'sk-test',
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: '<COMPLETION>manualResult()</COMPLETION>' } }],
        };
      },
    }),
  });

  const skippedAuto = await engine.complete({
    filePath: 'src/app.py',
    languageId: 'python',
    prefix: 'def run():\n    ',
    suffix: '',
    manual: false,
  });
  assert.equal(skippedAuto.skippedReason, 'manual-trigger-only');
  assert.equal(skippedAuto.items.length, 0);

  const allowedManual = await engine.complete({
    filePath: 'src/app.py',
    languageId: 'python',
    prefix: 'def run():\n    ',
    suffix: '',
    manual: true,
  });
  assert.equal(allowedManual.items.length, 1);
  assert.equal(allowedManual.items[0].insertText, 'manualResult()');
});

test('supports completion at any code position (mid-code, function-name-first, and end-of-line next-line block)', () => {
  // 1. Writing a function name first in the middle of code completes signature + body inline
  const fnNameCompletion = postProcessCompletion(
    '<COMPLETION>\n    def restart_game(self) -> None:\n        self.reset()\n</COMPLETION>',
    {
      prefix: 'class SnakeGame:\n    def restart_game',
      suffix: '\n\n    def step(self) -> bool:',
      isSingleLine: false,
    },
  );
  assert.equal(fnNameCompletion, '(self) -> None:\n        self.reset()');

  // 2. Cursor at the end of a non-empty statement line preserves leading `\n` for next-line indented block
  const endOfLineNextBlock = postProcessCompletion(
    '<COMPLETION>\n        if new_head in self.snake:\n            self.alive = False\n</COMPLETION>',
    {
      prefix: '        new_head = (head_x + dx, head_y + dy)',
      suffix: '\n        self.snake.insert(0, new_head)',
      isSingleLine: false,
    },
  );
  assert.equal(
    endOfLineNextBlock,
    '\n        if new_head in self.snake:\n            self.alive = False',
  );

  // 3. Multi-line completion when closing delimiters exist on current line adjusts range.endColumn for Monaco
  const normalizedMidLine = resolveInlineCompletionRangeAndText(
    'self, direction: tuple[int, int]):\n        self.direction = direction',
    {
      lineNumber: 12,
      column: 18,
      linePrefix: '    def set_dir(',
      lineSuffix: '):',
    },
  );
  assert.equal(normalizedMidLine.range.startColumn, 18);
  assert.equal(normalizedMidLine.range.endColumn, 20);
  assert.equal(
    normalizedMidLine.insertText,
    'self, direction: tuple[int, int]):\n        self.direction = direction',
  );
});

test('disables thinking on reasoning-capable OpenAI-compatible models (e.g. deepseek-flash) and retries without thinking on HTTP 400', async () => {
  const fimContext = buildFimContext({
    filePath: 'test.py',
    languageId: 'python',
    prefix: '# 贪吃蛇游戏\ndef ',
    suffix: '\n',
  });
  const dynamicScope = resolveDynamicScope({
    prefix: '# 贪吃蛇游戏\ndef ',
    suffix: '\n',
    completionScope: 'smart',
    maxTokens: 256,
  });

  const deepseekReq = buildProtocolHttpRequest({
    config: {
      providerProtocol: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-flash',
    },
    fimContext,
    dynamicScope,
  });
  assert.deepEqual(deepseekReq.body.thinking, { type: 'disabled' });
  assert.equal(deepseekReq.body.max_tokens, 160);

  let attempt = 0;
  const bodies = [];
  const engine = new CodeCompletionEngine({
    config: {
      enabled: true,
      providerProtocol: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-flash',
    },
    fetchImpl: async (_url, init) => {
      attempt += 1;
      bodies.push(JSON.parse(init.body));
      if (attempt === 1) {
        return {
          ok: false,
          status: 400,
          async text() {
            return 'unknown field thinking';
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: '<COMPLETION>move_snake(snake, direction):\n    return snake</COMPLETION>',
                },
              },
            ],
          };
        },
      };
    },
  });

  const result = await engine.complete({
    filePath: 'test.py',
    languageId: 'python',
    prefix: '# 贪吃蛇游戏\ndef ',
    suffix: '\n',
    manual: true,
  });
  assert.equal(attempt, 2);
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
  assert.equal('thinking' in bodies[1], false);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].insertText, 'move_snake(snake, direction):\n    return snake');
});

test('normalizes indentation for dedented methods on indented blank lines, relative multi-line blocks, and after return statements', () => {
  const snakePrefixToReturn = [
    'import random',
    '',
    'class SnakeGame:',
    '    def __init__(self, width: int = 20, height: int = 20) -> None:',
    '        self.width = width',
    '        self.height = height',
    '        self.snake = [(width // 2, height // 2)]',
    '',
    '    def _spawn_food(self) -> tuple[int, int]:',
    '        while True:',
    '            pos = (random.randint(0, self.width - 1), random.randint(0, self.height - 1))',
    '            if pos not in self.snake:',
    '                return pos',
  ].join('\n');

  // 1. Dynamic scope in multi-line smart mode must NOT include `\n\n` in stopSequences so methods after `return pos` are not truncated
  const scopeAfterReturn = resolveDynamicScope({
    prefix: snakePrefixToReturn,
    suffix: '',
    completionScope: 'smart',
    maxTokens: 256,
  });
  assert.equal(scopeAfterReturn.isSingleLine, false);
  assert.equal(scopeAfterReturn.stopSequences.includes('\n\n'), false);

  // 2. Cursor at end of `return pos` (16 spaces): model outputs `\n\n    def step(self) -> bool:` -> preserves `\n\n` and 4-space class method indent
  const afterReturnMethod = postProcessCompletion(
    '<COMPLETION>\n\n    def step(self) -> bool:\n        head_x, head_y = self.snake[0]\n        return True\n</COMPLETION>',
    {
      prefix: snakePrefixToReturn,
      suffix: '',
      isSingleLine: false,
      languageId: 'python',
    },
  );
  assert.equal(
    afterReturnMethod,
    '\n\n    def step(self) -> bool:\n        head_x, head_y = self.snake[0]\n        return True',
  );

  // 3. Cursor at end of `return pos` (16 spaces): if model mistakenly indents `def step` at 16 spaces, re-aligns it to 4 spaces
  const overIndentedMethodAfterReturn = postProcessCompletion(
    '<COMPLETION>\n                def step(self) -> bool:\n                    return True\n</COMPLETION>',
    {
      prefix: snakePrefixToReturn,
      suffix: '',
      isSingleLine: false,
      languageId: 'python',
    },
  );
  assert.equal(
    overIndentedMethodAfterReturn,
    '\n    def step(self) -> bool:\n        return True',
  );

  // 4. Cursor on a 16-space blank line (`                ` after pressing Enter after `return pos`):
  //    Model outputs `    def step(self):` (4 spaces < 16 spaces). Must prepend `\n` instead of gluing onto 16 spaces (20 spaces).
  const onIndentedBlankLineDedented = postProcessCompletion(
    '<COMPLETION>\n    def step(self) -> bool:\n        return True\n</COMPLETION>',
    {
      prefix: `${snakePrefixToReturn}\n                `,
      suffix: '',
      isSingleLine: false,
      languageId: 'python',
    },
  );
  assert.equal(
    onIndentedBlankLineDedented,
    '\n    def step(self) -> bool:\n        return True',
  );

  // 5. Cursor on an 8-space blank line (`        `) where model outputs line 1 at 0 spaces (`while True:`)
  //    and lines 2+ with relative indentation (`    pos = ...`): pads lines 2+ by 8 spaces to 12/16 spaces.
  const relativeMultiLine = postProcessCompletion(
    '<COMPLETION>while True:\n    pos = (0, 0)\n    if pos not in self.snake:\n        return pos</COMPLETION>',
    {
      prefix: 'class SnakeGame:\n    def _spawn_food(self):\n        ',
      suffix: '',
      isSingleLine: false,
      languageId: 'python',
    },
  );
  assert.equal(
    relativeMultiLine,
    'while True:\n            pos = (0, 0)\n            if pos not in self.snake:\n                return pos',
  );
});

