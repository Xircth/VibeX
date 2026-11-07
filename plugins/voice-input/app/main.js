export const PLUGIN_ID = 'vibex.voice-input';
export const VOICE_STORAGE_KEY = 'vibex.voice-input.config';
export const VOICE_HISTORY_STORAGE_KEY = 'vibex.voice-input.history';

export const DEFAULT_VOICE_CONFIG = Object.freeze({
  enabled: true,
  providerProtocol: 'hybrid',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini-transcribe',
  cleanupModel: 'gpt-4o-mini',
  language: 'auto',
  recordingMode: 'toggle',
  shortcut: 'Alt+V',
  cleanupMode: 'auto-clean',
  vocabulary:
    'VibeX, Tauri, Monaco, TypeScript, Rust, React, MCP, Skill, Worktree, Claude, Codex',
  audioDeviceId: 'default',
  showFloatingHud: true,
});

const LANGUAGE_BCP47_MAP = Object.freeze({
  auto: 'zh-CN',
  zh: 'zh-CN',
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
});

export function resolveBcp47Language(lang = 'auto') {
  const key = String(lang || 'auto').trim().toLowerCase();
  return LANGUAGE_BCP47_MAP[key] || 'zh-CN';
}

export function parseVocabularyList(rawVocabulary) {
  if (Array.isArray(rawVocabulary)) {
    return rawVocabulary
      .map((item) => String(item ?? '').trim())
      .filter(Boolean);
  }
  if (typeof rawVocabulary !== 'string' || !rawVocabulary.trim()) {
    return [];
  }
  return rawVocabulary
    .split(/[,，;\n\r]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const PHONETIC_TERM_ALIASES = Object.freeze({
  VibeX: [/\bvibe\s*[-_]?\s*x\b/gi, /\bvibex\b/gi],
  Tauri: [/\btauri\b/gi, /淘瑞/g],
  Monaco: [/\bmonaco\b/gi],
  TypeScript: [/\btype\s*script\b/gi, /\btypescript\b/gi],
  JavaScript: [/\bjava\s*script\b/gi, /\bjavascript\b/gi],
  Worktree: [/\bwork\s*tree\b/gi, /\bworktree\b/gi],
  Claude: [/\bclaude\b/gi],
  Codex: [/\bcodex\b/gi],
  React: [/\breact\b/gi],
  Rust: [/\brust\b/gi],
  MCP: [/\bmcp\b/gi, /\bm\.c\.p\.?\b/gi],
});

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeVocabularyTerms(text, vocabulary) {
  if (typeof text !== 'string' || !text) return '';
  let output = text;
  const terms = parseVocabularyList(vocabulary);
  for (const term of terms) {
    const aliases = PHONETIC_TERM_ALIASES[term];
    if (Array.isArray(aliases)) {
      for (const regex of aliases) {
        output = output.replace(regex, term);
      }
    }
    if (/^[A-Za-z][A-Za-z0-9._-]*$/.test(term)) {
      const fallbackRx = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
      output = output.replace(fallbackRx, term);
    }
  }
  return output;
}

export function cleanTranscriptText(rawText, options = {}) {
  if (typeof rawText !== 'string') return '';
  let text = rawText.trim();
  if (!text) return '';
  const cleanupMode = options.cleanupMode || 'auto-clean';
  const vocabulary = options.vocabulary ?? DEFAULT_VOICE_CONFIG.vocabulary;
  if (cleanupMode === 'off') {
    return normalizeVocabularyTerms(text.replace(/\s+/g, ' ').trim(), vocabulary);
  }
  text = text.replace(/^(?:[嗯啊呃哦唉]+[，,、。\s]*)+/g, '');
  text = text.replace(
    /(?:(?<=^)|(?<=[，,。！？；：、\s]))(?:嗯+|啊+|呃+|那个就是说|就是说呢|怎么说呢|然后呢就是)[，,、\s]*/g,
    '',
  );
  text = text.replace(/\s*[嗯呃]+[，,、]+/g, '，');
  text = text.replace(/\b(?:um+|uh+|er+|erm+|ah+)\b[,\s]*/gi, '');
  text = text.replace(/\b([A-Za-z]+)\s+\1\b/gi, '$1');
  text = text.replace(/([我你他她它这那])(?:\s*[，,、]?\s*\1)+/g, '$1');
  text = normalizeVocabularyTerms(text, vocabulary);
  text = text.replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, '$1 $2');
  text = text.replace(/([A-Za-z0-9])([\u4e00-\u9fa5])/g, '$1 $2');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/^[，,、；;：:\s]+/, '').trim();
  return text.trim();
}

const VALID_PROTOCOLS = new Set([
  'hybrid',
  'openai-whisper',
  'groq-whisper',
  'openai-chat-audio',
  'browser-speech',
]);
const VALID_LANGUAGES = new Set(['auto', 'zh', 'en', 'ja', 'ko']);
const VALID_RECORDING_MODES = new Set(['toggle', 'push-to-talk']);
const VALID_CLEANUP_MODES = new Set(['auto-clean', 'preview', 'off']);

export function normalizeVoiceConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled:
      typeof src.enabled === 'boolean'
        ? src.enabled
        : DEFAULT_VOICE_CONFIG.enabled,
    providerProtocol: VALID_PROTOCOLS.has(src.providerProtocol)
      ? src.providerProtocol
      : DEFAULT_VOICE_CONFIG.providerProtocol,
    baseUrl:
      typeof src.baseUrl === 'string' && src.baseUrl.trim()
        ? src.baseUrl.trim()
        : DEFAULT_VOICE_CONFIG.baseUrl,
    apiKey: typeof src.apiKey === 'string' ? src.apiKey.trim() : '',
    model:
      typeof src.model === 'string' && src.model.trim()
        ? src.model.trim()
        : DEFAULT_VOICE_CONFIG.model,
    cleanupModel:
      typeof src.cleanupModel === 'string' && src.cleanupModel.trim()
        ? src.cleanupModel.trim()
        : DEFAULT_VOICE_CONFIG.cleanupModel,
    language: VALID_LANGUAGES.has(src.language)
      ? src.language
      : DEFAULT_VOICE_CONFIG.language,
    recordingMode: VALID_RECORDING_MODES.has(src.recordingMode)
      ? src.recordingMode
      : DEFAULT_VOICE_CONFIG.recordingMode,
    shortcut:
      typeof src.shortcut === 'string' && src.shortcut.trim()
        ? src.shortcut.trim()
        : DEFAULT_VOICE_CONFIG.shortcut,
    cleanupMode: VALID_CLEANUP_MODES.has(src.cleanupMode)
      ? src.cleanupMode
      : DEFAULT_VOICE_CONFIG.cleanupMode,
    vocabulary:
      typeof src.vocabulary === 'string'
        ? src.vocabulary
        : Array.isArray(src.vocabulary)
          ? src.vocabulary.join(', ')
          : DEFAULT_VOICE_CONFIG.vocabulary,
    audioDeviceId:
      typeof src.audioDeviceId === 'string' && src.audioDeviceId.trim()
        ? src.audioDeviceId.trim()
        : DEFAULT_VOICE_CONFIG.audioDeviceId,
    showFloatingHud:
      typeof src.showFloatingHud === 'boolean'
        ? src.showFloatingHud
        : DEFAULT_VOICE_CONFIG.showFloatingHud,
  };
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

export function parseShortcut(shortcutStr) {
  if (!shortcutStr || typeof shortcutStr !== 'string') return null;
  const parts = shortcutStr
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;

  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  let key = '';

  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') ctrl = true;
    else if (part === 'alt' || part === 'option' || part === 'opt') alt = true;
    else if (part === 'shift') shift = true;
    else if (part === 'meta' || part === 'cmd' || part === 'command' || part === 'win')
      meta = true;
    else key = part;
  }
  if (!key) return null;
  return { ctrl, alt, shift, meta, key };
}

export function doesEventMatchShortcut(event, shortcutStr) {
  const parsed = parseShortcut(shortcutStr);
  if (!parsed || !event) return false;
  if (Boolean(event.ctrlKey) !== parsed.ctrl) return false;
  if (Boolean(event.altKey) !== parsed.alt) return false;
  if (Boolean(event.shiftKey) !== parsed.shift) return false;
  if (Boolean(event.metaKey) !== parsed.meta) return false;

  const eventKey = String(event.key || '').trim().toLowerCase();
  const eventCode = String(event.code || '').trim().toLowerCase();
  if (eventKey === parsed.key) return true;
  if (parsed.key.length === 1 && eventCode === `key${parsed.key}`) return true;
  if (parsed.key === 'space' && (eventKey === ' ' || eventCode === 'space')) return true;
  return false;
}

export function formatKeyboardEventToShortcut(event) {
  if (!event || !event.key) return null;
  const ignoredKeys = new Set(['Control', 'Alt', 'Shift', 'Meta']);
  if (ignoredKeys.has(event.key)) return null;

  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  if (parts.length === 0) return null;

  const rawKey = event.key === ' ' ? 'Space' : event.key;
  const keyLabel =
    rawKey.length === 1 ? rawKey.toUpperCase() : rawKey;
  parts.push(keyLabel);
  return parts.join('+');
}

function blobToBase64(blob) {
  if (!blob) return Promise.resolve('');
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((ab) => {
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(ab).toString('base64');
      }
      const bytes = new Uint8Array(ab);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i]);
      }
      return typeof btoa === 'function' ? btoa(binary) : '';
    });
  }
  return Promise.resolve('');
}

export class VoiceSessionController {
  constructor(options = {}) {
    this.config = normalizeVoiceConfig(options.config);
    this.invokeWorker = options.invokeWorker || (async () => null);
    this.insertIntoComposer = options.insertIntoComposer || (async () => false);
    this.getEditorBridge = options.getEditorBridge || (() => null);
    this.speechRecognitionFactory =
      options.speechRecognitionFactory ||
      (() => {
        if (typeof globalThis === 'undefined') return null;
        const Ctor =
          globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
        return typeof Ctor === 'function' ? new Ctor() : null;
      });
    this.getUserMedia =
      options.getUserMedia ||
      (async (constraints) => {
        if (
          typeof navigator !== 'undefined' &&
          navigator.mediaDevices &&
          typeof navigator.mediaDevices.getUserMedia === 'function'
        ) {
          return await navigator.mediaDevices.getUserMedia(constraints);
        }
        return null;
      });
    this.mediaRecorderFactory =
      options.mediaRecorderFactory ||
      ((stream) => {
        if (typeof globalThis !== 'undefined' && typeof globalThis.MediaRecorder === 'function') {
          const mimeType =
            typeof globalThis.MediaRecorder.isTypeSupported === 'function' &&
            globalThis.MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
              ? 'audio/webm;codecs=opus'
              : 'audio/webm';
          try {
            return new globalThis.MediaRecorder(stream, { mimeType });
          } catch {
            return new globalThis.MediaRecorder(stream);
          }
        }
        return null;
      });

    this.state = 'idle'; // 'idle' | 'recording' | 'transcribing' | 'preview' | 'error'
    this.recordingStartedAt = 0;
    this.elapsedMs = 0;
    this.liveInterimText = '';
    this.liveFinalSegments = [];
    this.audioLevels = [0.18, 0.25, 0.2, 0.15];
    this.lastResult = null;
    this.previewDraft = null;
    this.lastError = null;
    this.history = [];
    this.listeners = new Set();

    this._durationTimer = null;
    this._mediaStream = null;
    this._mediaRecorder = null;
    this._recordedChunks = [];
    this._recognition = null;
    this._audioContext = null;
    this._analyserTimer = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify() {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {
        // ignore listener errors
      }
    }
  }

  getSnapshot() {
    const combinedLive = [
      ...this.liveFinalSegments,
      this.liveInterimText,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    return {
      state: this.state,
      config: { ...this.config },
      elapsedMs: this.elapsedMs,
      durationLabel: formatDuration(this.elapsedMs),
      liveTranscript: combinedLive,
      audioLevels: [...this.audioLevels],
      lastResult: this.lastResult ? { ...this.lastResult } : null,
      previewDraft: this.previewDraft ? { ...this.previewDraft } : null,
      lastError: this.lastError,
      history: [...this.history],
    };
  }

  updateConfig(partial = {}) {
    this.config = normalizeVoiceConfig({
      ...this.config,
      ...(partial && typeof partial === 'object' ? partial : {}),
    });
    this.notify();
    return this.config;
  }

  async startRecording() {
    if (!this.config.enabled) {
      this.lastError = '语音输入已禁用，请在设置中开启';
      this.state = 'error';
      this.notify();
      return { started: false, reason: 'disabled' };
    }
    if (this.state === 'recording') {
      return { started: true, alreadyRecording: true };
    }

    this.lastError = null;
    this.previewDraft = null;
    this.liveInterimText = '';
    this.liveFinalSegments = [];
    this._recordedChunks = [];
    this.recordingStartedAt = Date.now();
    this.elapsedMs = 0;
    this.state = 'recording';
    this.notify();

    this._durationTimer = setInterval(() => {
      if (this.state === 'recording') {
        this.elapsedMs = Date.now() - this.recordingStartedAt;
        this.notify();
      }
    }, 200);

    // 1. Start Web Speech API live captioning when protocol is hybrid or browser-speech
    if (
      this.config.providerProtocol === 'hybrid' ||
      this.config.providerProtocol === 'browser-speech'
    ) {
      try {
        const recognition = this.speechRecognitionFactory();
        if (recognition) {
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = resolveBcp47Language(this.config.language);
          recognition.onresult = (event) => {
            let interim = '';
            const finals = [...this.liveFinalSegments];
            const startIdx = typeof event.resultIndex === 'number' ? event.resultIndex : 0;
            const results = event.results || [];
            for (let i = startIdx; i < results.length; i += 1) {
              const res = results[i];
              const transcript = String(res?.[0]?.transcript || '').trim();
              if (!transcript) continue;
              if (res.isFinal) {
                finals.push(transcript);
              } else {
                interim += `${interim ? ' ' : ''}${transcript}`;
              }
            }
            this.liveFinalSegments = finals;
            this.liveInterimText = interim;
            this.notify();
          };
          recognition.onerror = () => {
            // Keep recording via MediaRecorder even if Web Speech API emits a non-fatal warning
          };
          recognition.start();
          this._recognition = recognition;
        }
      } catch {
        // Ignore if SpeechRecognition is unsupported in current WebView
      }
    }

    // 2. Start MediaRecorder + AudioContext waveform analyser if available
    try {
      const audioConstraint =
        this.config.audioDeviceId && this.config.audioDeviceId !== 'default'
          ? { deviceId: { exact: this.config.audioDeviceId } }
          : true;
      const stream = await this.getUserMedia({ audio: audioConstraint });
      if (stream) {
        this._mediaStream = stream;
        const recorder = this.mediaRecorderFactory(stream);
        if (recorder) {
          this._mediaRecorder = recorder;
          recorder.ondataavailable = (ev) => {
            if (ev?.data && ev.data.size > 0) {
              this._recordedChunks.push(ev.data);
            }
          };
          recorder.start(250);
        }
        this._startWaveformAnalyser(stream);
      }
    } catch (err) {
      if (!this._recognition) {
        this._cleanupMediaResources();
        this.state = 'error';
        this.lastError = `无法访问麦克风: ${String(err?.message || err)}`;
        this.notify();
        return { started: false, error: this.lastError };
      }
    }

    return { started: true };
  }

  _startWaveformAnalyser(stream) {
    try {
      const AudioCtx =
        typeof globalThis !== 'undefined' &&
        (globalThis.AudioContext || globalThis.webkitAudioContext);
      if (typeof AudioCtx !== 'function') return;
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 32;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      this._audioContext = audioCtx;
      this._analyserTimer = setInterval(() => {
        if (this.state !== 'recording') return;
        analyser.getByteFrequencyData(dataArray);
        const step = Math.max(1, Math.floor(dataArray.length / 4));
        this.audioLevels = [0, 1, 2, 3].map((idx) => {
          const val = dataArray[idx * step] || 0;
          return Math.max(0.15, Math.min(1, Number((val / 255).toFixed(2))));
        });
        this.notify();
      }, 100);
    } catch {
      // Fallback animated pulse levels
    }
  }

  _cleanupMediaResources() {
    if (this._durationTimer) {
      clearInterval(this._durationTimer);
      this._durationTimer = null;
    }
    if (this._analyserTimer) {
      clearInterval(this._analyserTimer);
      this._analyserTimer = null;
    }
    if (this._recognition) {
      try {
        this._recognition.stop();
      } catch {
        // ignore
      }
      this._recognition = null;
    }
    if (this._mediaStream && typeof this._mediaStream.getTracks === 'function') {
      for (const track of this._mediaStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    }
    this._mediaStream = null;
    if (this._audioContext && typeof this._audioContext.close === 'function') {
      void this._audioContext.close().catch(() => {});
    }
    this._audioContext = null;
    this.audioLevels = [0.18, 0.25, 0.2, 0.15];
  }

  async stopRecording(overrideOptions = {}) {
    if (this.state !== 'recording') {
      return { stopped: false, reason: 'not-recording' };
    }

    const liveCaptured = [
      ...this.liveFinalSegments,
      this.liveInterimText,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    let recordedBlob = null;
    let mimeType = 'audio/webm';
    if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
      mimeType = this._mediaRecorder.mimeType || 'audio/webm';
      await new Promise((resolve) => {
        const prevOnStop = this._mediaRecorder.onstop;
        this._mediaRecorder.onstop = (ev) => {
          if (typeof prevOnStop === 'function') prevOnStop(ev);
          resolve();
        };
        try {
          this._mediaRecorder.stop();
        } catch {
          resolve();
        }
      });
    }
    if (this._recordedChunks.length > 0 && typeof Blob === 'function') {
      recordedBlob = new Blob(this._recordedChunks, { type: mimeType });
    }
    this._mediaRecorder = null;
    this._cleanupMediaResources();

    this.state = 'transcribing';
    this.notify();

    try {
      const audioBase64 =
        overrideOptions.audioBase64 ??
        (recordedBlob ? await blobToBase64(recordedBlob) : '');
      const effectiveLiveText =
        typeof overrideOptions.liveTranscript === 'string'
          ? overrideOptions.liveTranscript
          : liveCaptured;

      let result = null;
      try {
        result = await this.invokeWorker('voice.transcribe', {
          audioBase64,
          mimeType,
          liveTranscript: effectiveLiveText,
          config: this.config,
        });
      } catch {
        result = null;
      }

      if (!result || typeof result !== 'object') {
        const rawText = effectiveLiveText;
        const cleanedText = cleanTranscriptText(rawText, {
          cleanupMode: this.config.cleanupMode,
          vocabulary: this.config.vocabulary,
        });
        result = {
          id: `local-${Date.now()}`,
          timestamp: Date.now(),
          rawText,
          cleanedText,
          text: this.config.cleanupMode === 'off' ? rawText : cleanedText,
          provider: 'local-fallback',
          cleanupMode: this.config.cleanupMode,
        };
      }

      const finalText = String(result.text || result.cleanedText || result.rawText || '').trim();
      if (!finalText) {
        this.state = 'idle';
        this.notify();
        return { stopped: true, text: '', inserted: false };
      }

      this.lastResult = result;
      this.history = [result, ...this.history].slice(0, 20);

      if (this.config.cleanupMode === 'preview') {
        this.state = 'preview';
        this.previewDraft = {
          rawText: result.rawText || finalText,
          cleanedText: result.cleanedText || finalText,
          selectedVariant: 'cleaned',
          editedText: result.cleanedText || finalText,
        };
        this.notify();
        return {
          stopped: true,
          preview: true,
          text: finalText,
          rawText: result.rawText,
          cleanedText: result.cleanedText,
        };
      }

      const insertion = await this.insertTranscriptIntoTarget(finalText);
      this.state = 'idle';
      this.notify();
      return {
        stopped: true,
        text: finalText,
        rawText: result.rawText,
        cleanedText: result.cleanedText,
        ...insertion,
      };
    } catch (err) {
      this.state = 'error';
      this.lastError = String(err?.message || err);
      this.notify();
      return { stopped: true, error: this.lastError, inserted: false };
    }
  }

  async toggleRecording() {
    if (this.state === 'recording') {
      return await this.stopRecording();
    }
    return await this.startRecording();
  }

  async commitPreview(useRaw = false) {
    if (!this.previewDraft) return { inserted: false };
    const textToInsert = useRaw
      ? this.previewDraft.rawText
      : this.previewDraft.editedText || this.previewDraft.cleanedText;
    this.previewDraft = null;
    this.state = 'idle';
    this.notify();
    if (!textToInsert) return { inserted: false };
    return await this.insertTranscriptIntoTarget(textToInsert);
  }

  cancelPreview() {
    this.previewDraft = null;
    if (this.state === 'recording') {
      this._cleanupMediaResources();
    }
    this.state = 'idle';
    this.notify();
  }

  async insertTranscriptIntoTarget(text) {
    const clean = String(text || '').trim();
    if (!clean) return { inserted: false, target: 'none' };

    // 1. Check active Monaco Editor with focus first
    const editorBridge = this.getEditorBridge();
    const activeEditor = editorBridge?.getActiveEditor?.();
    if (
      activeEditor &&
      typeof activeEditor.hasTextFocus === 'function' &&
      activeEditor.hasTextFocus() &&
      typeof activeEditor.executeEdits === 'function'
    ) {
      const pos =
        typeof activeEditor.getPosition === 'function'
          ? activeEditor.getPosition()
          : { lineNumber: 1, column: 1 };
      if (typeof activeEditor.pushUndoStop === 'function') {
        activeEditor.pushUndoStop();
      }
      activeEditor.executeEdits(PLUGIN_ID, [
        {
          range: {
            startLineNumber: pos.lineNumber,
            startColumn: pos.column,
            endLineNumber: pos.lineNumber,
            endColumn: pos.column,
          },
          text: clean,
          forceMoveMarkers: true,
        },
      ]);
      if (typeof activeEditor.pushUndoStop === 'function') {
        activeEditor.pushUndoStop();
      }
      return { inserted: true, target: 'monaco-editor', text: clean };
    }

    // 2. Insert into VibeX Session Composer via `conversation.draft.insert`
    try {
      const inserted = await this.insertIntoComposer(clean);
      if (inserted) {
        return { inserted: true, target: 'session-composer', text: clean };
      }
    } catch {
      // Fall through to focused DOM element / clipboard
    }

    // 3. Check focused native HTML textarea or input
    if (typeof document !== 'undefined' && document.activeElement) {
      const el = document.activeElement;
      const tag = String(el.tagName || '').toLowerCase();
      if (
        (tag === 'textarea' || tag === 'input') &&
        !el.disabled &&
        !el.readOnly &&
        typeof el.value === 'string'
      ) {
        const start =
          typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
        const end =
          typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
        const before = el.value.slice(0, start);
        const after = el.value.slice(end);
        const sep = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
        el.value = `${before}${sep}${clean}${after}`;
        if (typeof el.dispatchEvent === 'function' && typeof Event === 'function') {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return { inserted: true, target: 'dom-input', text: clean };
      }
    }

    // 4. Fallback to clipboard
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(clean);
        return { inserted: false, copiedToClipboard: true, target: 'clipboard', text: clean };
      } catch {
        // ignore
      }
    }

    return { inserted: false, target: 'none', text: clean };
  }

  dispose() {
    this._cleanupMediaResources();
    this.listeners.clear();
  }
}

function loadPersistedConfig() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(VOICE_STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    }
  } catch {
    // ignore
  }
  return {};
}

function savePersistedConfig(cfg) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(cfg));
    }
  } catch {
    // ignore
  }
}

export default {
  apiVersion: '2.0',
  id: PLUGIN_ID,

  activate(context) {
    if (typeof globalThis.__vibexVoiceInputActiveCleanup__ === 'function') {
      try {
        globalThis.__vibexVoiceInputActiveCleanup__();
      } catch {
        // ignore
      }
    }

    const initialCfg = normalizeVoiceConfig({
      ...DEFAULT_VOICE_CONFIG,
      ...loadPersistedConfig(),
      ...(typeof context?.config?.getAll === 'function'
        ? context.config.getAll()
        : context?.config && typeof context.config === 'object'
          ? context.config
          : {}),
    });

    const invokeWorker = async (handler, params = {}) => {
      if (typeof context?.worker?.invoke === 'function') {
        return await context.worker.invoke(handler, params);
      }
      if (typeof context?.invokeContribution === 'function') {
        return await context.invokeContribution(handler, params);
      }
      if (typeof context?.host?.invokeWorker === 'function') {
        return await context.host.invokeWorker(handler, params);
      }
      return null;
    };

    const getEditorBridge = () => {
      if (typeof context?.services?.get === 'function') {
        try {
          return context.services.get('vibex.code-editor');
        } catch {
          return null;
        }
      }
      return null;
    };

    const insertIntoComposer = async (text) => {
      if (typeof context?.conversation?.call === 'function') {
        const res = await context.conversation.call('draft.insert', {
          text,
          token: { label: '', markdown: '', text },
        });
        return Boolean(res && res.inserted !== false);
      }
      return false;
    };

    const controller = new VoiceSessionController({
      config: initialCfg,
      invokeWorker,
      getEditorBridge,
      insertIntoComposer,
    });

    const persistAndSyncConfig = (partial) => {
      const next = controller.updateConfig(partial);
      savePersistedConfig(next);
      void invokeWorker('voice.configure', next).catch(() => {});
      if (typeof context?.settings?.set === 'function') {
        void context.settings.set(next).catch(() => {});
      }
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(
          new CustomEvent('vibex:plugin-config-updated', {
            detail: { pluginId: PLUGIN_ID, config: next },
          }),
        );
      }
      return next;
    };

    // Provide service for other plugins or tests
    const disposers = [];
    if (typeof context?.services?.provide === 'function') {
      try {
        const disp = context.services.provide('vibex.voice-input', {
          startRecording: () => controller.startRecording(),
          stopRecording: (opts) => controller.stopRecording(opts),
          toggleRecording: () => controller.toggleRecording(),
          getSnapshot: () => controller.getSnapshot(),
          updateConfig: (cfg) => persistAndSyncConfig(cfg),
        });
        if (typeof disp === 'function') disposers.push(disp);
      } catch {
        // ignore if already provided
      }
    }

    // Register React UI components if React is available in Host
    const React = globalThis.React || globalThis.__VIBEX_HOST_MODULES__?.react;
    if (React && typeof React.createElement === 'function') {
      const h = React.createElement;
      const { useState, useEffect } = React;

      function useVoiceSnapshot() {
        const [snap, setSnap] = useState(() => controller.getSnapshot());
        useEffect(() => controller.subscribe(setSnap), []);
        return snap;
      }

      // 1. Composer Toolbar Microphone Button (`composer.toolbar` slot)
      function VoiceComposerToolbarButton(props = {}) {
        const snap = useVoiceSnapshot();
        if (!snap.config.enabled) return null;

        const isRecording = snap.state === 'recording';
        const isTranscribing = snap.state === 'transcribing';
        const isPushToTalk = snap.config.recordingMode === 'push-to-talk';
        const shortcut = snap.config.shortcut || 'Alt+V';
        const disabled = props.isEditable === false || isTranscribing;

        const handlePointerDown = (ev) => {
          if (disabled || !isPushToTalk) return;
          ev.preventDefault();
          void controller.startRecording();
        };
        const handlePointerUp = (ev) => {
          if (disabled || !isPushToTalk) return;
          ev.preventDefault();
          if (controller.state === 'recording') {
            void controller.stopRecording();
          }
        };
        const handleClick = (ev) => {
          if (disabled || isPushToTalk) return;
          ev.preventDefault();
          void controller.toggleRecording();
        };

        if (isRecording) {
          return h(
            'button',
            {
              type: 'button',
              onClick: handleClick,
              onPointerUp: handlePointerUp,
              title: `正在录音 (${snap.durationLabel}) · 点击停止并转写 (${shortcut})`,
              'aria-label': '停止语音输入',
              'data-testid': 'voice-composer-recording-button',
              className:
                'inline-flex h-7 items-center gap-1.5 rounded-full bg-destructive/15 px-2.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/25',
            },
            h('span', {
              className: 'h-2 w-2 rounded-full bg-destructive animate-pulse',
            }),
            h(
              'span',
              { className: 'inline-flex items-end gap-0.5 h-3' },
              ...snap.audioLevels.map((lvl, idx) =>
                h('span', {
                  key: idx,
                  style: {
                    height: `${Math.max(3, Math.round(lvl * 12))}px`,
                    width: '2px',
                  },
                  className: 'rounded-full bg-destructive transition-all duration-75',
                }),
              ),
            ),
            h('span', { className: 'tabular-nums' }, snap.durationLabel),
          );
        }

        if (isTranscribing) {
          return h(
            'button',
            {
              type: 'button',
              disabled: true,
              title: '正在识别并润色语音…',
              'aria-label': '正在识别语音',
              'data-testid': 'voice-composer-transcribing-button',
              className:
                'inline-flex h-7 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 text-xs font-medium text-primary',
            },
            h(
              'span',
              {
                className:
                  'h-3 w-3 rounded-full border-2 border-primary border-t-transparent animate-spin',
              },
            ),
            h('span', null, '识别中…'),
          );
        }

        return h(
          'button',
          {
            type: 'button',
            disabled,
            onClick: handleClick,
            onPointerDown: handlePointerDown,
            onPointerUp: handlePointerUp,
            title: isPushToTalk
              ? `按住说话 (${shortcut})`
              : `AI 语音输入 (${shortcut})`,
            'aria-label': 'AI 语音输入',
            'data-testid': 'voice-composer-mic-button',
            className:
              'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled: opacity-50',
          },
          h(
            'svg',
            {
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: '1.8',
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              className: 'h-3.5 w-3.5',
            },
            h('rect', { x: '9', y: '2', width: '6', height: '11', rx: '3' }),
            h('path', { d: 'M5 10a7 7 0 0 0 14 0' }),
            h('line', { x1: '12', y1: '17', x2: '12', y2: '21' }),
            h('line', { x1: '8', y1: '21', x2: '16', y2: '21' }),
          ),
        );
      }

      // 2. Status Bar Studio Popover View (`voice-input-status` view in `status.after-mcp`)
      function VoiceStatusPopoverView() {
        const snap = useVoiceSnapshot();
        const [recordingShortcut, setRecordingShortcut] = useState(false);
        const [devices, setDevices] = useState([]);
        const [testDraft, setTestDraft] = useState('');
        const [showRaw, setShowRaw] = useState(false);
        const [hotwordDraft, setHotwordDraft] = useState('');

        useEffect(() => {
          if (snap.lastResult) {
            setTestDraft(
              showRaw
                ? snap.lastResult.rawText || ''
                : snap.lastResult.cleanedText || snap.lastResult.text || '',
            );
          }
        }, [snap.lastResult, showRaw]);

        useEffect(() => {
          if (
            typeof navigator !== 'undefined' &&
            navigator.mediaDevices &&
            typeof navigator.mediaDevices.enumerateDevices === 'function'
          ) {
            void navigator.mediaDevices
              .enumerateDevices()
              .then((list) => {
                setDevices(
                  list.filter((d) => d.kind === 'audioinput'),
                );
              })
              .catch(() => {});
          }
        }, []);

        const cfg = snap.config;
        const isRecording = snap.state === 'recording';
        const isTranscribing = snap.state === 'transcribing';

        return h(
          'div',
          {
            className:
              'flex h-full w-full flex-col overflow-y-auto bg-background p-4 text-xs text-foreground gap-4',
            'data-testid': 'voice-status-popover-studio',
          },
          // Header
          h(
            'div',
            { className: 'flex items-center justify-between border-b border-border pb-3' },
            h(
              'div',
              { className: 'flex items-center gap-2' },
              h('span', { className: 'text-sm font-semibold' }, 'AI 语音输入与智能听写'),
              h(
                'span',
                {
                  className:
                    'rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary',
                },
                cfg.providerProtocol,
              ),
            ),
            h(
              'label',
              { className: 'flex items-center gap-2 cursor-pointer' },
              h('span', { className: 'text-muted-foreground' }, cfg.enabled ? '已启用' : '已禁用'),
              h('input', {
                type: 'checkbox',
                checked: Boolean(cfg.enabled),
                onChange: (e) => persistAndSyncConfig({ enabled: e.target.checked }),
                className: 'h-4 w-4 accent-primary',
              }),
            ),
          ),

          // Live Dictation & Test Box
          h(
            'div',
            {
              className:
                'flex flex-col gap-2.5 rounded-lg border border-border bg-muted/30 p-3',
            },
            h(
              'div',
              { className: 'flex items-center justify-between' },
              h(
                'div',
                { className: 'flex items-center gap-2' },
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => void controller.toggleRecording(),
                    disabled: !cfg.enabled || isTranscribing,
                    className: isRecording
                      ? 'inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 font-medium text-destructive-foreground'
                      : 'inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground',
                  },
                  isRecording
                    ? `停止录音 (${snap.durationLabel})`
                    : isTranscribing
                      ? '正在识别与润色…'
                      : `开始语音听写 (${cfg.shortcut})`,
                ),
                isRecording
                  ? h(
                      'span',
                      { className: 'text-destructive font-medium animate-pulse' },
                      snap.liveTranscript || '正在聆听麦克风输入…',
                    )
                  : null,
              ),
              snap.lastResult
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => setShowRaw((v) => !v),
                      className:
                        'rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent',
                    },
                    showRaw ? '查看润色结果' : '查看原始识别',
                  )
                : null,
            ),
            h('textarea', {
              rows: 3,
              value: isRecording ? snap.liveTranscript : testDraft,
              onChange: (e) => setTestDraft(e.target.value),
              placeholder: '点击上方按钮或按快捷键说话，识别与智能去口水词结果将显示在此处…',
              className:
                'w-full rounded-md border border-border bg-background p-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary',
            }),
            h(
              'div',
              { className: 'flex items-center justify-between' },
              h(
                'span',
                { className: 'text-[11px] text-muted-foreground' },
                snap.lastError
                  ? `错误: ${snap.lastError}`
                  : snap.lastResult
                    ? `最近识别耗时 ${snap.lastResult.latencyMs || 1}ms · 引擎: ${snap.lastResult.provider}`
                    : `支持会话输入框与代码编辑器光标处直接写入`,
              ),
              h(
                'div',
                { className: 'flex items-center gap-1.5' },
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !testDraft.trim(),
                    onClick: () => void controller.insertTranscriptIntoTarget(testDraft),
                    className:
                      'rounded-md bg-primary/15 px-2.5 py-1 font-medium text-primary hover:bg-primary/25 disabled:opacity-40',
                  },
                  '插入当前输入框',
                ),
              ),
            ),
          ),

          // Configuration Grid
          h(
            'div',
            { className: 'grid grid-cols-2 gap-3' },
            // Protocol
            h(
              'label',
              { className: 'flex flex-col gap-1' },
              h('span', { className: 'font-medium text-muted-foreground' }, '识别引擎协议'),
              h(
                'select',
                {
                  value: cfg.providerProtocol,
                  onChange: (e) =>
                    persistAndSyncConfig({ providerProtocol: e.target.value }),
                  className:
                    'h-8 rounded-md border border-border bg-background px-2 text-xs',
                },
                h('option', { value: 'hybrid' }, '混合流式 + 云端 Whisper (推荐)'),
                h('option', { value: 'openai-whisper' }, 'OpenAI Whisper (/v1/audio/transcriptions)'),
                h('option', { value: 'groq-whisper' }, 'Groq 极速 Whisper (whisper-large-v3-turbo)'),
                h('option', { value: 'openai-chat-audio' }, '多模态 Chat Audio (/v1/chat/completions)'),
                h('option', { value: 'browser-speech' }, '浏览器/系统原生实时听写 (免 Key)'),
              ),
            ),
            // Language
            h(
              'label',
              { className: 'flex flex-col gap-1' },
              h('span', { className: 'font-medium text-muted-foreground' }, '识别语言提示'),
              h(
                'select',
                {
                  value: cfg.language,
                  onChange: (e) => persistAndSyncConfig({ language: e.target.value }),
                  className:
                    'h-8 rounded-md border border-border bg-background px-2 text-xs',
                },
                h('option', { value: 'auto' }, '自动检测 (中英混合)'),
                h('option', { value: 'zh' }, '中文 (zh-CN)'),
                h('option', { value: 'en' }, 'English (en-US)'),
                h('option', { value: 'ja' }, '日本語 (ja-JP)'),
                h('option', { value: 'ko' }, '한국어 (ko-KR)'),
              ),
            ),
            // Cleanup Mode
            h(
              'label',
              { className: 'flex flex-col gap-1' },
              h('span', { className: 'font-medium text-muted-foreground' }, '听写后智能润色 (Orca Cleanup)'),
              h(
                'select',
                {
                  value: cfg.cleanupMode,
                  onChange: (e) => persistAndSyncConfig({ cleanupMode: e.target.value }),
                  className:
                    'h-8 rounded-md border border-border bg-background px-2 text-xs',
                },
                h('option', { value: 'auto-clean' }, '自动去口水词与术语纠错后直接插入'),
                h('option', { value: 'preview' }, '弹出润色 vs 原文对照预览确认后插入'),
                h('option', { value: 'off' }, '关闭润色 (仅输出原始识别结果)'),
              ),
            ),
            // Recording Mode & Shortcut
            h(
              'div',
              { className: 'flex flex-col gap-1' },
              h('span', { className: 'font-medium text-muted-foreground' }, '触发方式与快捷键'),
              h(
                'div',
                { className: 'flex items-center gap-1.5' },
                h(
                  'select',
                  {
                    value: cfg.recordingMode,
                    onChange: (e) =>
                      persistAndSyncConfig({ recordingMode: e.target.value }),
                    className:
                      'h-8 flex-1 rounded-md border border-border bg-background px-2 text-xs',
                  },
                  h('option', { value: 'toggle' }, '单击切换开始/结束'),
                  h('option', { value: 'push-to-talk' }, '按住说话松开转写'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => setRecordingShortcut((v) => !v),
                    onKeyDown: (e) => {
                      if (!recordingShortcut) return;
                      e.preventDefault();
                      e.stopPropagation();
                      if (e.key === 'Escape') {
                        setRecordingShortcut(false);
                        return;
                      }
                      const nextSc = formatKeyboardEventToShortcut(e);
                      if (nextSc) {
                        persistAndSyncConfig({ shortcut: nextSc });
                        setRecordingShortcut(false);
                      }
                    },
                    className:
                      'h-8 rounded-md border border-border bg-muted/50 px-2.5 font-mono text-xs hover:bg-accent',
                  },
                  recordingShortcut ? '请按键…' : cfg.shortcut,
                ),
              ),
            ),
            // Microphone Device
            h(
              'label',
              { className: 'flex flex-col gap-1' },
              h('span', { className: 'font-medium text-muted-foreground' }, '麦克风输入设备'),
              h(
                'select',
                {
                  value: cfg.audioDeviceId,
                  onChange: (e) =>
                    persistAndSyncConfig({ audioDeviceId: e.target.value }),
                  className:
                    'h-8 rounded-md border border-border bg-background px-2 text-xs',
                },
                h('option', { value: 'default' }, '系统默认麦克风'),
                ...devices.map((d, i) =>
                  h(
                    'option',
                    { key: d.deviceId || i, value: d.deviceId },
                    d.label || `麦克风 ${i + 1}`,
                  ),
                ),
              ),
            ),
            // Model
            h(
              'label',
              { className: 'flex flex-col gap-1' },
              h('span', { className: 'font-medium text-muted-foreground' }, '语音识别模型'),
              h('input', {
                type: 'text',
                value: cfg.model,
                onChange: (e) => persistAndSyncConfig({ model: e.target.value }),
                placeholder: 'gpt-4o-mini-transcribe / whisper-1 / whisper-large-v3-turbo',
                className:
                  'h-8 rounded-md border border-border bg-background px-2 text-xs',
              }),
            ),
            // Base URL
            h(
              'label',
              { className: 'flex flex-col gap-1' },
              h('span', { className: 'font-medium text-muted-foreground' }, 'API Base URL'),
              h('input', {
                type: 'text',
                value: cfg.baseUrl,
                onChange: (e) => persistAndSyncConfig({ baseUrl: e.target.value }),
                placeholder: 'https://api.openai.com/v1',
                className:
                  'h-8 rounded-md border border-border bg-background px-2 text-xs',
              }),
            ),
            // API Key
            h(
              'label',
              { className: 'flex flex-col gap-1' },
              h('span', { className: 'font-medium text-muted-foreground' }, 'API Key (可选，留空自动使用环境变量/流式听写)'),
              h('input', {
                type: 'password',
                value: cfg.apiKey,
                onChange: (e) => persistAndSyncConfig({ apiKey: e.target.value }),
                placeholder: 'sk-...',
                className:
                  'h-8 rounded-md border border-border bg-background px-2 text-xs',
              }),
            ),
          ),

          // Custom Vocabulary / Hotwords (Token Pill List)
          (() => {
            const vocabTokens = Array.from(
              new Set(parseVocabularyList(cfg.vocabulary)),
            );
            const commitTokens = (nextTokens) => {
              const deduped = Array.from(
                new Set(parseVocabularyList(nextTokens)),
              );
              persistAndSyncConfig({ vocabulary: deduped.join(', ') });
            };
            const addFromDraft = (raw) => {
              const added = parseVocabularyList(raw);
              if (added.length > 0) {
                commitTokens([...vocabTokens, ...added]);
              }
              setHotwordDraft('');
            };
            return h(
              'div',
              { className: 'flex flex-col gap-1.5' },
              h(
                'span',
                { className: 'font-medium text-muted-foreground' },
                `自定义术语热词表 (${vocabTokens.length} 个 Token · 自动注入 Whisper 提示词与专名纠错)`,
              ),
              h(
                'div',
                {
                  'data-testid': 'voice-vocabulary-token-list',
                  className:
                    'flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5',
                },
                ...vocabTokens.map((term, idx) =>
                  h(
                    'span',
                    {
                      key: `${term}-${idx}`,
                      'data-testid': 'voice-vocabulary-token',
                      className:
                        'inline-flex items-center gap-1 rounded border border-primary/25 bg-primary/10 px-2 py-0.5 text-xs font-medium text-foreground',
                    },
                    h('span', null, term),
                    h(
                      'button',
                      {
                        type: 'button',
                        'aria-label': `移除 ${term}`,
                        onClick: () =>
                          commitTokens(vocabTokens.filter((_, i) => i !== idx)),
                        className:
                          'inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-muted-foreground hover:bg-primary/20 hover:text-foreground',
                      },
                      '×',
                    ),
                  ),
                ),
                h('input', {
                  type: 'text',
                  'aria-label': '添加自定义术语热词',
                  value: hotwordDraft,
                  onChange: (e) => setHotwordDraft(e.target.value),
                  onKeyDown: (e) => {
                    if (
                      e.key === 'Enter' ||
                      e.key === ',' ||
                      e.key === '，' ||
                      e.key === ';'
                    ) {
                      e.preventDefault();
                      if (hotwordDraft.trim()) {
                        addFromDraft(hotwordDraft);
                      }
                      return;
                    }
                    if (
                      e.key === 'Backspace' &&
                      hotwordDraft === '' &&
                      vocabTokens.length > 0
                    ) {
                      e.preventDefault();
                      commitTokens(vocabTokens.slice(0, -1));
                    }
                  },
                  onBlur: () => {
                    if (hotwordDraft.trim()) {
                      addFromDraft(hotwordDraft);
                    }
                  },
                  placeholder: '输入热词后按 Enter 添加…',
                  className:
                    'h-6 min-w-[120px] flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground',
                }),
              ),
            );
          })(),

          // Recent History
          snap.history.length > 0
            ? h(
                'div',
                { className: 'flex flex-col gap-1.5 border-t border-border pt-3' },
                h('span', { className: 'font-medium text-muted-foreground' }, '最近语音听写记录'),
                ...snap.history.slice(0, 5).map((item) =>
                  h(
                    'div',
                    {
                      key: item.id,
                      className:
                        'flex items-center justify-between gap-2 rounded border border-border/60 bg-muted/20 px-2.5 py-1.5',
                    },
                    h('span', { className: 'truncate flex-1' }, item.text),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () =>
                          void controller.insertTranscriptIntoTarget(item.text),
                        className:
                          'shrink-0 rounded bg-accent px-2 py-0.5 text-[11px] hover:bg-accent/80',
                      },
                      '重插',
                    ),
                  ),
                ),
              )
            : null,
        );
      }

      if (typeof context?.registerSlot === 'function') {
        const slotDisp = context.registerSlot({
          id: 'voice-composer-button',
          slot: 'composer.toolbar',
          label: 'AI 语音输入',
          tooltip: `开始/停止语音输入 (${initialCfg.shortcut})`,
          order: 20,
          onActivate: () => controller.toggleRecording(),
          component: VoiceComposerToolbarButton,
        });
        if (typeof slotDisp === 'function') disposers.push(slotDisp);
      }

      if (typeof context?.registerView === 'function') {
        const viewDisp = context.registerView({
          id: 'voice-input-status',
          title: 'AI语音输入',
          slot: 'status.after-mcp',
          component: VoiceStatusPopoverView,
        });
        if (typeof viewDisp === 'function') disposers.push(viewDisp);
      }
    }

    // 3. Floating Live Caption & Preview HUD in DOM when recording / previewing
    let hudRoot = null;
    const renderDomHud = (snap) => {
      if (typeof document === 'undefined' || !document.body) return;
      const shouldShow =
        snap.config.enabled &&
        snap.config.showFloatingHud &&
        (snap.state === 'recording' ||
          snap.state === 'transcribing' ||
          snap.state === 'preview');

      if (!shouldShow) {
        if (hudRoot) {
          hudRoot.remove();
          hudRoot = null;
        }
        return;
      }

      if (!hudRoot) {
        hudRoot = document.createElement('div');
        hudRoot.setAttribute('data-vibex-voice-hud', 'true');
        hudRoot.style.cssText =
          'position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:2147483000;min-width:280px;max-width:560px;padding:10px 16px;border-radius:999px;background:var(--surface-popover,rgba(24,24,27,0.94));color:var(--text-strong,#fafafa);border:1px solid rgba(255,255,255,0.14);box-shadow:0 12px 32px rgba(0,0,0,0.28);display:flex;align-items:center;gap:12px;font-size:13px;backdrop-filter:blur(10px);';
        document.body.appendChild(hudRoot);
      }

      hudRoot.innerHTML = '';
      if (snap.state === 'recording') {
        const dot = document.createElement('span');
        dot.style.cssText =
          'width:10px;height:10px;border-radius:999px;background:#ef4444;flex-shrink:0;';
        const text = document.createElement('span');
        text.style.cssText =
          'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        text.textContent =
          snap.liveTranscript || `正在聆听 (${snap.durationLabel}) · 按 ${snap.config.shortcut} 结束`;
        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.textContent = '完成';
        stopBtn.style.cssText =
          'padding:3px 10px;border-radius:999px;background:#ef4444;color:#fff;border:none;cursor:pointer;font-size:12px;font-weight:500;';
        stopBtn.onclick = () => void controller.stopRecording();
        hudRoot.append(dot, text, stopBtn);
      } else if (snap.state === 'transcribing') {
        const label = document.createElement('span');
        label.textContent = '正在通过 AI 转写并清理口水词…';
        hudRoot.append(label);
      } else if (snap.state === 'preview' && snap.previewDraft) {
        const text = document.createElement('span');
        text.style.cssText =
          'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        text.textContent = snap.previewDraft.cleanedText;
        const insertBtn = document.createElement('button');
        insertBtn.type = 'button';
        insertBtn.textContent = '插入润色';
        insertBtn.style.cssText =
          'padding:3px 10px;border-radius:999px;background:#3b82f6;color:#fff;border:none;cursor:pointer;font-size:12px;';
        insertBtn.onclick = () => void controller.commitPreview(false);
        const rawBtn = document.createElement('button');
        rawBtn.type = 'button';
        rawBtn.textContent = '插入原文';
        rawBtn.style.cssText =
          'padding:3px 10px;border-radius:999px;background:rgba(255,255,255,0.12);color:inherit;border:none;cursor:pointer;font-size:12px;';
        rawBtn.onclick = () => void controller.commitPreview(true);
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText =
          'padding:3px 8px;border-radius:999px;background:transparent;color:inherit;border:none;cursor:pointer;font-size:12px;opacity:0.75;';
        cancelBtn.onclick = () => controller.cancelPreview();
        hudRoot.append(text, insertBtn, rawBtn, cancelBtn);
      }
    };

    disposers.push(controller.subscribe(renderDomHud));

    // 4. Global Keyboard Shortcut Listener (`Alt+V` toggle or push-to-talk)
    let pttKeyActive = false;
    const onWindowKeyDown = (event) => {
      const cfg = controller.config;
      if (!cfg.enabled) return;

      if (controller.state === 'preview') {
        if (event.key === 'Escape') {
          event.preventDefault?.();
          controller.cancelPreview();
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault?.();
          void controller.commitPreview(false);
          return;
        }
      }

      if (!doesEventMatchShortcut(event, cfg.shortcut)) return;
      if (event.repeat) return;

      event.preventDefault?.();
      event.stopPropagation?.();

      if (cfg.recordingMode === 'push-to-talk') {
        pttKeyActive = true;
        void controller.startRecording();
      } else {
        void controller.toggleRecording();
      }
    };

    const onWindowKeyUp = (event) => {
      if (!pttKeyActive) return;
      const cfg = controller.config;
      if (cfg.recordingMode !== 'push-to-talk') {
        pttKeyActive = false;
        return;
      }
      const parsed = parseShortcut(cfg.shortcut);
      const releasedKey = String(event.key || '').trim().toLowerCase();
      if (
        !parsed ||
        releasedKey === parsed.key ||
        releasedKey === 'alt' ||
        releasedKey === 'control' ||
        releasedKey === 'shift' ||
        releasedKey === 'meta'
      ) {
        pttKeyActive = false;
        if (controller.state === 'recording') {
          void controller.stopRecording();
        }
      }
    };

    const onWindowConfigUpdated = (event) => {
      const detail = event?.detail;
      if (
        detail &&
        (detail.pluginId === PLUGIN_ID || detail.pluginId === 'voice-input') &&
        detail.config &&
        typeof detail.config === 'object'
      ) {
        controller.updateConfig(detail.config);
        savePersistedConfig(controller.config);
      }
    };

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', onWindowKeyDown, true);
      window.addEventListener('keyup', onWindowKeyUp, true);
      window.addEventListener('vibex:plugin-config-updated', onWindowConfigUpdated);
    }

    // 5. Register command & status handlers
    const registerHandler = (name, fn) => {
      if (typeof context?.registerHandler === 'function') {
        context.registerHandler(name, fn);
      }
      if (typeof context?.commands?.register === 'function') {
        context.commands.register(name, fn);
      }
    };

    registerHandler('voice.status', async () => {
      const workerStatus =
        (await invokeWorker('voice.status', {}).catch(() => null)) || {};
      const snap = controller.getSnapshot();
      return {
        ...workerStatus,
        ...snap.config,
        state: snap.state,
        lastError: snap.lastError || workerStatus.metrics?.lastError || null,
        text: snap.config.enabled
          ? snap.state === 'recording'
            ? `录音中 ${snap.durationLabel}`
            : `语音输入 (${snap.config.shortcut})`
          : '语音输入 (已禁用)',
        tooltip: snap.config.enabled
          ? `AI 语音输入 (${snap.config.providerProtocol}) · 快捷键 ${snap.config.shortcut}`
          : 'AI 语音输入已禁用',
      };
    });

    registerHandler('voice.toggle', async (params) => {
      if (params && typeof params.enabled === 'boolean') {
        const next = persistAndSyncConfig({ enabled: params.enabled });
        return { enabled: next.enabled, state: controller.state };
      }
      return await controller.toggleRecording();
    });

    registerHandler('voice.transcribe', async (params) => {
      if (controller.state === 'recording') {
        return await controller.stopRecording(params || {});
      }
      const res = await invokeWorker('voice.transcribe', params || {});
      if (res?.text && params?.autoInsert !== false) {
        await controller.insertTranscriptIntoTarget(res.text);
      }
      return res;
    });

    registerHandler('voice.cleanup', async (params) => {
      return await invokeWorker('voice.cleanup', params || {});
    });

    registerHandler('voice.configure', async (params) => {
      if (params && typeof params === 'object') {
        persistAndSyncConfig(params);
      }
      return controller.getSnapshot();
    });

    const disposeInstance = () => {
      if (globalThis.__vibexVoiceInputActiveCleanup__ === disposeInstance) {
        globalThis.__vibexVoiceInputActiveCleanup__ = null;
      }
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('keydown', onWindowKeyDown, true);
        window.removeEventListener('keyup', onWindowKeyUp, true);
        window.removeEventListener('vibex:plugin-config-updated', onWindowConfigUpdated);
      }
      if (hudRoot) {
        hudRoot.remove();
        hudRoot = null;
      }
      for (const d of disposers.splice(0)) {
        try {
          d();
        } catch {
          // ignore
        }
      }
      controller.dispose();
    };

    globalThis.__vibexVoiceInputActiveCleanup__ = disposeInstance;

    return Object.assign(disposeInstance, {
      controller,
      dispose: disposeInstance,
    });
  },
};
