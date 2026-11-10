import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import appModule, {
  PLUGIN_ID,
  VoiceSessionController,
  doesEventMatchShortcut,
  encodeMonoWavBase64,
  formatDuration,
  formatKeyboardEventToShortcut,
  normalizeVoiceConfig,
  parseShortcut,
} from '../app/main.js';
import {
  DEFAULT_VOICE_CONFIG,
  VoiceInputEngine,
  buildChatAudioRequest,
  buildCleanupChatRequest,
  buildMultipartAudioRequest,
  buildWhisperPrompt,
  cleanTranscriptText,
  createVoiceInputWorkerDefinition,
  normalizeVocabularyTerms,
  parseVocabularyList,
} from '../worker/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(__dirname, '..');

describe('vibex.voice-input plugin', () => {
  it('validates v4 manifest and integrations', () => {
    const manifest = JSON.parse(
      readFileSync(join(pluginRoot, '.vibex-plugin', 'plugin.json'), 'utf8'),
    );
    assert.equal(manifest.manifestVersion, 4);
    assert.equal(manifest.apiVersion, '2.0');
    assert.equal(manifest.id, 'vibex.voice-input');
    assert.equal(manifest.entrypoints.worker.path, 'dist/worker.mjs');
    assert.equal(manifest.entrypoints.app.entry, 'app/main.js');

    const statusIntegration = manifest.integrations.find(
      (item) => item.id === 'voice-input-status',
    );
    assert.ok(statusIntegration);
    assert.equal(statusIntegration.slot, 'status.after-mcp');
    assert.equal(statusIntegration.handler, 'voice.status');
  });

  it('parses custom vocabulary and builds Whisper prompts', () => {
    const terms = parseVocabularyList('VibeX, Tauri，Monaco\nWorktree');
    assert.deepEqual(terms, ['VibeX', 'Tauri', 'Monaco', 'Worktree']);

    const zhPrompt = buildWhisperPrompt(terms, 'zh');
    assert.match(zhPrompt, /VibeX, Tauri, Monaco, Worktree/);

    const enPrompt = buildWhisperPrompt(terms, 'en');
    assert.match(enPrompt, /Technical glossary/);
  });

  it('normalizes vocabulary terms and strips spoken filler words', () => {
    const raw =
      '嗯，那个就是说，我我想要在 vibe x 里面用 type script 修改一下 淘瑞 窗口的 monaco 编辑器';
    const cleaned = cleanTranscriptText(raw, {
      cleanupMode: 'auto-clean',
      vocabulary: 'VibeX, Tauri, Monaco, TypeScript',
    });
    assert.ok(!cleaned.startsWith('嗯'));
    assert.ok(!cleaned.includes('那个就是说'));
    assert.ok(!cleaned.includes('我我'));
    assert.match(cleaned, /VibeX/);
    assert.match(cleaned, /TypeScript/);
    assert.match(cleaned, /Tauri/);
    assert.match(cleaned, /Monaco/);
  });

  it('preserves raw phrasing when cleanupMode is off', () => {
    const raw = 'um we use vibe x and rust';
    const cleaned = cleanTranscriptText(raw, {
      cleanupMode: 'off',
      vocabulary: 'VibeX, Rust',
    });
    assert.equal(cleaned, 'um we use VibeX and Rust');
  });

  it('builds OpenAI Whisper and Groq multipart audio requests', () => {
    const sampleAudio = Buffer.from('RIFF-fake-wav').toString('base64');
    const openaiReq = buildMultipartAudioRequest({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-123',
      providerProtocol: 'openai-whisper',
      model: 'gpt-4o-mini-transcribe',
      audioBase64: sampleAudio,
      mimeType: 'audio/wav',
      language: 'zh',
      vocabulary: 'VibeX, Tauri',
    });
    assert.equal(openaiReq.url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(openaiReq.headers.Authorization, 'Bearer sk-test-123');
    assert.ok(Buffer.isBuffer(openaiReq.body));
    const bodyStr = openaiReq.body.toString('utf8');
    assert.match(bodyStr, /gpt-4o-mini-transcribe/);
    assert.match(bodyStr, /speech\.wav/);

    const groqReq = buildMultipartAudioRequest({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'gsk-test',
      providerProtocol: 'groq-whisper',
      model: 'gpt-4o-mini-transcribe',
      audioBase64: sampleAudio,
      mimeType: 'audio/webm',
    });
    assert.equal(
      groqReq.url,
      'https://api.groq.com/openai/v1/audio/transcriptions',
    );
    assert.equal(groqReq.model, 'whisper-large-v3-turbo');
  });

  it('builds multimodal Chat Audio and LLM cleanup requests', () => {
    const sampleAudio = Buffer.from('fake-pcm').toString('base64');
    const chatAudioReq = buildChatAudioRequest({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-audio',
      model: 'gpt-4o-audio-preview',
      audioBase64: `data:audio/wav;base64,${sampleAudio}`,
      mimeType: 'audio/wav',
      vocabulary: 'VibeX',
    });
    assert.equal(
      chatAudioReq.url,
      'https://api.openai.com/v1/chat/completions',
    );
    const parsedBody = JSON.parse(chatAudioReq.body);
    assert.equal(parsedBody.model, 'gpt-4o-audio-preview');
    assert.equal(
      parsedBody.messages[0].content[1].input_audio.data,
      sampleAudio,
    );

    const cleanupReq = buildCleanupChatRequest({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-clean',
      model: 'gpt-4o-mini',
      rawText: '嗯 帮我看看 vibe x',
      vocabulary: 'VibeX',
    });
    const parsedCleanup = JSON.parse(cleanupReq.body);
    assert.equal(parsedCleanup.messages[0].role, 'system');
    assert.match(parsedCleanup.messages[0].content, /VibeX/);
  });

  it('transcribes via cloud Whisper and applies post-transcription cleanup in VoiceInputEngine', async () => {
    const calls = [];
    const engine = new VoiceInputEngine({
      config: {
        ...DEFAULT_VOICE_CONFIG,
        providerProtocol: 'openai-whisper',
        apiKey: 'sk-mock-whisper',
        cleanupMode: 'auto-clean',
      },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            text: '嗯，那个就是说，请帮我检查 vibe x 的 monaco 插件状态',
          }),
        };
      },
    });

    const res = await engine.transcribe({
      audioBase64: Buffer.from('audio-bytes').toString('base64'),
      mimeType: 'audio/webm',
    });

    assert.equal(calls.length, 1);
    assert.equal(res.provider, 'openai-whisper');
    assert.equal(
      res.rawText,
      '嗯，那个就是说，请帮我检查 vibe x 的 monaco 插件状态',
    );
    assert.match(res.cleanedText, /请帮我检查 VibeX 的 Monaco 插件状态/);
    assert.equal(res.text, res.cleanedText);
  });

  it('gracefully falls back to live browser speech in hybrid mode when no API key is configured', async () => {
    const engine = new VoiceInputEngine({
      config: {
        ...DEFAULT_VOICE_CONFIG,
        providerProtocol: 'hybrid',
        apiKey: '',
      },
    });

    const res = await engine.transcribe({
      liveTranscript: '呃 我想要重构一下 work tree 管理模块',
    });

    assert.equal(res.provider, 'hybrid-browser-speech');
    assert.match(res.text, /我想要重构一下 Worktree 管理模块/);
  });

  it('matches shortcuts and formats durations accurately', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(5400), '0:05');
    assert.equal(formatDuration(65000), '1:05');

    const parsed = parseShortcut('Alt+V');
    assert.deepEqual(parsed, {
      ctrl: false,
      alt: true,
      shift: false,
      meta: false,
      key: 'v',
    });

    assert.equal(
      doesEventMatchShortcut(
        { altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, key: 'v', code: 'KeyV' },
        'Alt+V',
      ),
      true,
    );
    assert.equal(
      formatKeyboardEventToShortcut({
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        key: 'v',
      }),
      'Ctrl+Shift+V',
    );
  });

  it('records, transcribes, and inserts into VibeX session composer or Monaco editor via VoiceSessionController', async () => {
    let insertedText = null;
    let fakeRecognition = null;

    const controller = new VoiceSessionController({
      config: normalizeVoiceConfig({
        enabled: true,
        providerProtocol: 'hybrid',
        cleanupMode: 'auto-clean',
      }),
      speechRecognitionFactory: () => {
        fakeRecognition = {
          continuous: false,
          interimResults: false,
          lang: '',
          start() {},
          stop() {},
        };
        return fakeRecognition;
      },
      getUserMedia: async () => null,
      invokeWorker: async (handler, params) => {
        if (handler === 'voice.transcribe') {
          const cleaned = cleanTranscriptText(params.liveTranscript, {
            cleanupMode: 'auto-clean',
            vocabulary: DEFAULT_VOICE_CONFIG.vocabulary,
          });
          return {
            id: 'test-1',
            rawText: params.liveTranscript,
            cleanedText: cleaned,
            text: cleaned,
            provider: 'hybrid-browser-speech',
          };
        }
        return null;
      },
      insertIntoComposer: async (text) => {
        insertedText = text;
        return true;
      },
    });

    const startRes = await controller.startRecording();
    assert.equal(startRes.started, true);
    assert.equal(controller.state, 'recording');

    // Simulate Web Speech API streaming result
    fakeRecognition.onresult({
      resultIndex: 0,
      results: [
        {
          isFinal: true,
          0: { transcript: '嗯 请在 vibe x 中打开 tauri 设置' },
        },
      ],
    });
    assert.match(controller.getSnapshot().liveTranscript, /vibe x/);

    const stopRes = await controller.stopRecording();
    assert.equal(stopRes.stopped, true);
    assert.equal(stopRes.inserted, true);
    assert.equal(stopRes.target, 'session-composer');
    assert.match(insertedText, /请在 VibeX 中打开 Tauri 设置/);
  });

  it('inserts with Undo Stop Barrier when a Monaco editor has focus', async () => {
    const undoStops = [];
    const edits = [];
    const controller = new VoiceSessionController({
      config: normalizeVoiceConfig({ enabled: true }),
      getEditorBridge: () => ({
        getActiveEditor: () => ({
          hasTextFocus: () => true,
          getPosition: () => ({ lineNumber: 3, column: 5 }),
          pushUndoStop: () => undoStops.push(Date.now()),
          executeEdits: (source, opList) => edits.push({ source, opList }),
        }),
      }),
    });

    const res = await controller.insertTranscriptIntoTarget('const voiceReady = true;');
    assert.equal(res.inserted, true);
    assert.equal(res.target, 'monaco-editor');
    assert.equal(undoStops.length, 2);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].source, PLUGIN_ID);
    assert.equal(edits[0].opList[0].text, 'const voiceReady = true;');
  });

  it('activates app/main.js and registers composer.toolbar slot, status view, and handlers', async () => {
    const slots = [];
    const views = [];
    const handlers = new Map();
    const draftCalls = [];

    const activated = appModule.activate({
      config: { enabled: true, shortcut: 'Alt+V' },
      registerSlot: (slotDef) => slots.push(slotDef),
      registerView: (viewDef) => views.push(viewDef),
      registerHandler: (name, fn) => handlers.set(name, fn),
      conversation: {
        call: async (op, payload) => {
          draftCalls.push({ op, payload });
          return { inserted: true };
        },
      },
      worker: {
        invoke: async (handler, input) => {
          const { engine } = createVoiceInputWorkerDefinition();
          if (handler === 'voice.transcribe') return await engine.transcribe(input);
          if (handler === 'voice.status') return engine.getStatus();
          return null;
        },
      },
    });

    assert.ok(handlers.has('voice.status'));
    assert.ok(handlers.has('voice.toggle'));
    assert.ok(handlers.has('voice.transcribe'));

    const status = await handlers.get('voice.status')();
    assert.equal(status.enabled, true);
    assert.match(status.text, /Alt\+V/);

    const transcribeRes = await handlers.get('voice.transcribe')({
      liveTranscript: '嗯 帮我运行 vibe x 单元测试',
    });
    assert.match(transcribeRes.text, /帮我运行 VibeX 单元测试/);
    assert.equal(draftCalls.length, 1);
    assert.equal(draftCalls[0].op, 'draft.insert');

    activated.dispose();
  });

  it('declares x-visible-when on cloud-only config fields so browser-speech hides API URL/Key/Model', () => {
    const manifest = JSON.parse(
      readFileSync(join(pluginRoot, '.vibex-plugin', 'plugin.json'), 'utf8'),
    );
    const props = manifest.config.schema.properties;
    for (const cloudKey of ['baseUrl', 'apiKey', 'model', 'cleanupModel']) {
      const visibleWhen = props[cloudKey]?.['x-visible-when']?.providerProtocol;
      assert.ok(Array.isArray(visibleWhen), `${cloudKey} should have x-visible-when.providerProtocol`);
      assert.ok(!visibleWhen.includes('browser-speech'), `${cloudKey} should be hidden for browser-speech`);
      assert.ok(visibleWhen.includes('hybrid'), `${cloudKey} should be visible for hybrid`);
    }
  });

  it('falls back to native OS speech recognition when browser-speech Web Speech API returns empty transcript', async () => {
    const wavBase64 = encodeMonoWavBase64(new Float32Array(1600), 16000);
    assert.ok(wavBase64.length > 44);

    let osCalledWithWav = null;
    const engine = new VoiceInputEngine({
      config: {
        ...DEFAULT_VOICE_CONFIG,
        providerProtocol: 'browser-speech',
        cleanupMode: 'auto-clean',
      },
      nativeOsTranscribeImpl: async (wav, lang) => {
        osCalledWithWav = { wav, lang };
        return '嗯 请帮我打开 vibe x 的语音设置';
      },
    });

    const res = await engine.transcribe({
      wavBase64,
      mimeType: 'audio/wav',
      liveTranscript: '',
    });

    assert.ok(osCalledWithWav);
    assert.equal(res.provider, 'os-speech');
    assert.match(res.text, /请帮我打开 VibeX 的语音设置/);
  });

  it('cancels recording cleanly via cancelRecording without inserting text', async () => {
    let inserted = false;
    const controller = new VoiceSessionController({
      config: normalizeVoiceConfig({
        enabled: true,
        providerProtocol: 'browser-speech',
      }),
      speechRecognitionFactory: () => ({
        continuous: false,
        interimResults: false,
        lang: '',
        start() {},
        stop() {},
      }),
      getUserMedia: async () => null,
      insertIntoComposer: async () => {
        inserted = true;
        return true;
      },
    });

    await controller.startRecording();
    assert.equal(controller.state, 'recording');
    const cancelRes = controller.cancelRecording();
    assert.equal(cancelRes.cancelled, true);
    assert.equal(controller.state, 'idle');
    assert.equal(inserted, false);
  });

  it('keeps HUD cancel/confirm buttons stable across rapid waveform notifications, uses contrast-safe on-accent color, and persists dragged position', async () => {
    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    const prevLocalStorage = globalThis.localStorage;

    const storageMap = new Map();
    globalThis.localStorage = {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
    };

    const windowListeners = new Map();
    globalThis.window = {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener: (type, fn) => {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type).add(fn);
      },
      removeEventListener: (type, fn) => {
        windowListeners.get(type)?.delete(fn);
      },
      dispatchEvent: () => {},
    };

    const makeMockElement = (tag) => {
      const attrs = new Map();
      const el = {
        tagName: tag.toUpperCase(),
        type: '',
        disabled: false,
        innerHTML: '',
        style: { cssText: '', left: '', top: '', bottom: '', transform: '', cursor: '', height: '', opacity: '' },
        children: [],
        parentNode: null,
        onpointerdown: null,
        onclick: null,
        setAttribute: (k, v) => attrs.set(k, String(v)),
        getAttribute: (k) => attrs.get(k) ?? null,
        appendChild: (child) => {
          child.parentNode = el;
          el.children.push(child);
          return child;
        },
        append: (...nodes) => {
          for (const n of nodes) el.appendChild(n);
        },
        remove: () => {
          if (el.parentNode) {
            el.parentNode.children = el.parentNode.children.filter((c) => c !== el);
            el.parentNode = null;
          }
        },
        closest: (selector) => {
          if (selector === 'button' && el.tagName === 'BUTTON') return el;
          return null;
        },
        getBoundingClientRect: () => ({
          left: el.style.left.endsWith('px') ? parseFloat(el.style.left) : 560,
          top: el.style.top.endsWith('px') ? parseFloat(el.style.top) : 690,
          width: 148,
          height: 34,
        }),
      };
      return el;
    };

    const body = makeMockElement('body');
    globalThis.document = {
      body,
      createElement: (tag) => makeMockElement(tag),
      querySelectorAll: () => [],
    };

    let activated = null;
    try {
      activated = appModule.activate({
        config: { enabled: true, showFloatingHud: true, providerProtocol: 'browser-speech' },
        conversation: {
          call: async () => ({ inserted: true }),
        },
        worker: {
          invoke: async (handler) => {
            if (handler === 'voice.transcribe') {
              return { text: '测试语音确认按钮', rawText: '测试语音确认按钮', cleanedText: '测试语音确认按钮' };
            }
            return null;
          },
        },
      });

      const { controller } = activated;
      controller.speechRecognitionFactory = () => {
        const rec = {
          continuous: false,
          interimResults: false,
          lang: '',
          onend: null,
          start() {},
          stop() {
            if (typeof rec.onend === 'function') rec.onend();
          },
        };
        return rec;
      };
      controller.getUserMedia = async () => null;

      await controller.startRecording();
      assert.equal(body.children.length, 1);
      const hudRoot = body.children[0];
      const [cancelBtn, waveContainer, confirmBtn] = hudRoot.children;

      // 1. Contrast-safe on-accent color on confirm button
      assert.match(
        confirmBtn.style.cssText,
        /color:var\(--color-on-accent,\s*hsl\(var\(--primary-foreground,\s*0 0% 100%\)\)\)/,
      );

      // 2. Rapid audio level notifications must NOT replace button DOM nodes
      controller.audioLevels = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.5, 0.9];
      controller.notify();
      controller.notify();
      assert.strictEqual(hudRoot.children[0], cancelBtn);
      assert.strictEqual(hudRoot.children[1], waveContainer);
      assert.strictEqual(hudRoot.children[2], confirmBtn);

      // 3. Dragging the HUD updates position and saves to localStorage
      hudRoot.onpointerdown({
        button: 0,
        clientX: 560,
        clientY: 690,
        target: waveContainer,
        preventDefault() {},
      });
      for (const fn of windowListeners.get('pointermove') || []) {
        fn({ clientX: 320, clientY: 240 });
      }
      for (const fn of windowListeners.get('pointerup') || []) {
        fn({});
      }
      assert.equal(hudRoot.style.left, '320px');
      assert.equal(hudRoot.style.top, '240px');
      const savedPos = JSON.parse(storageMap.get('vibex.voice-input.hud-position'));
      assert.deepEqual(savedPos, { left: 320, top: 240 });

      // 4. Clicking cancelBtn stops recording immediately
      cancelBtn.onclick({ preventDefault() {}, stopPropagation() {} });
      assert.equal(controller.state, 'idle');
      assert.equal(body.children.length, 0);

      // 5. Re-opening HUD restores persisted position and confirmBtn completes recording
      await controller.startRecording();
      const reopenedHud = body.children[0];
      assert.equal(reopenedHud.style.left, '320px');
      assert.equal(reopenedHud.style.top, '240px');
      const reopenedConfirmBtn = reopenedHud.children[2];
      reopenedConfirmBtn.onclick({ preventDefault() {}, stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(controller.state, 'idle');
      assert.equal(body.children.length, 0);
    } finally {
      activated?.dispose();
      globalThis.document = prevDocument;
      globalThis.window = prevWindow;
      globalThis.localStorage = prevLocalStorage;
    }
  });
});

