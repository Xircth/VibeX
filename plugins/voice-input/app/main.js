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

export function encodeMonoWavBase64(float32Samples, sampleRate = 16000) {
  if (!float32Samples || float32Samples.length === 0) return '';
  const targetRate = 16000;
  const ratio = sampleRate > targetRate ? sampleRate / targetRate : 1;
  const outLength = Math.max(1, Math.floor(float32Samples.length / ratio));
  const buffer = new ArrayBuffer(44 + outLength * 2);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  const effectiveRate = ratio === 1 ? Math.round(sampleRate) : targetRate;
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + outLength * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format = 1
  view.setUint16(22, 1, true); // Mono = 1 channel
  view.setUint32(24, effectiveRate, true);
  view.setUint32(28, effectiveRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, outLength * 2, true);

  let offset = 44;
  for (let i = 0; i < outLength; i += 1) {
    const srcIdx = Math.min(float32Samples.length - 1, Math.floor(i * ratio));
    const s = Math.max(-1, Math.min(1, float32Samples[srcIdx] || 0));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64');
  }
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return typeof btoa === 'function' ? btoa(binary) : '';
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
    this.audioLevels = [0.16, 0.22, 0.28, 0.35, 0.26, 0.18, 0.24, 0.32, 0.22, 0.16];
    this.lastResult = null;
    this.previewDraft = null;
    this.lastError = null;
    this.history = [];
    this.listeners = new Set();

    this._durationTimer = null;
    this._mediaStream = null;
    this._mediaRecorder = null;
    this._recordedChunks = [];
    this._pcmChunks = [];
    this._pcmSampleRate = 16000;
    this._scriptProcessor = null;
    this._recognition = null;
    this._recognitionStopping = false;
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
    this._pcmChunks = [];
    this._recognitionStopping = false;
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
    this._durationTimer?.unref?.();

    // 1. Start Web Speech API live captioning when protocol is hybrid or browser-speech
    if (
      this.config.providerProtocol === 'hybrid' ||
      this.config.providerProtocol === 'browser-speech'
    ) {
      this._startWebSpeechRecognition();
    }

    // 2. Start MediaRecorder + AudioContext waveform analyser + PCM WAV capture
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

  _startWebSpeechRecognition() {
    try {
      const recognition = this.speechRecognitionFactory();
      if (!recognition) return;

      let committedFromSession = [];
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.lang = resolveBcp47Language(this.config.language);

      recognition.onresult = (event) => {
        const results = event?.results;
        if (!results) return;
        const sessionFinals = [];
        let interim = '';
        for (let i = 0; i < results.length; i += 1) {
          const res = results[i];
          const alt = res?.[0] ?? (typeof res?.item === 'function' ? res.item(0) : null);
          const transcript = String(alt?.transcript || '').trim();
          if (!transcript) continue;
          if (res.isFinal) {
            sessionFinals.push(transcript);
          } else {
            interim += `${interim ? ' ' : ''}${transcript}`;
          }
        }
        committedFromSession = sessionFinals;
        this.liveFinalSegments = [
          ...(this._priorRecognitionSegments || []),
          ...sessionFinals,
        ];
        this.liveInterimText = interim;
        this.notify();
      };

      recognition.onerror = () => {
        // Keep recording via MediaRecorder/PCM even if Web Speech API emits a warning
      };

      recognition.onend = () => {
        if (this.liveInterimText) {
          committedFromSession.push(this.liveInterimText);
          this.liveFinalSegments = [
            ...(this._priorRecognitionSegments || []),
            ...committedFromSession,
          ];
          this.liveInterimText = '';
        }
        this._priorRecognitionSegments = [...this.liveFinalSegments];
        if (this.state === 'recording' && !this._recognitionStopping) {
          try {
            recognition.start();
          } catch {
            // ignore restart errors
          }
        }
      };

      this._priorRecognitionSegments = [];
      recognition.start();
      this._recognition = recognition;
    } catch {
      // Ignore if SpeechRecognition is unsupported in current WebView
    }
  }

  _startWaveformAnalyser(stream) {
    try {
      const AudioCtx =
        typeof globalThis !== 'undefined' &&
        (globalThis.AudioContext || globalThis.webkitAudioContext);
      if (typeof AudioCtx !== 'function') return;
      const audioCtx = new AudioCtx();
      if (typeof audioCtx.resume === 'function' && audioCtx.state === 'suspended') {
        void audioCtx.resume().catch(() => {});
      }
      this._pcmSampleRate = audioCtx.sampleRate || 16000;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.65;
      source.connect(analyser);

      // Capture raw mono PCM for native OS speech recognition fallback (WAV)
      if (typeof audioCtx.createScriptProcessor === 'function') {
        try {
          const processor = audioCtx.createScriptProcessor(4096, 1, 1);
          processor.onaudioprocess = (event) => {
            if (this.state !== 'recording') return;
            const input = event?.inputBuffer?.getChannelData?.(0);
            if (input && input.length > 0) {
              this._pcmChunks.push(new Float32Array(input));
            }
          };
          source.connect(processor);
          processor.connect(audioCtx.destination);
          this._scriptProcessor = processor;
        } catch {
          // ignore if createScriptProcessor is unavailable
        }
      }

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      this._audioContext = audioCtx;
      const barCount = 10;
      this._analyserTimer = setInterval(() => {
        if (this.state !== 'recording') return;
        analyser.getByteFrequencyData(dataArray);
        const step = Math.max(1, Math.floor(dataArray.length / barCount));
        this.audioLevels = Array.from({ length: barCount }, (_, idx) => {
          const val = dataArray[idx * step] || 0;
          return Math.max(0.15, Math.min(1, Number((val / 255).toFixed(2))));
        });
        this.notify();
      }, 80);
      this._analyserTimer?.unref?.();
    } catch {
      // Fallback animated pulse levels
    }
  }

  _buildCapturedWavBase64() {
    if (!this._pcmChunks || this._pcmChunks.length === 0) return '';
    let totalLen = 0;
    for (const chunk of this._pcmChunks) {
      totalLen += chunk.length;
    }
    if (totalLen === 0) return '';
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of this._pcmChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return encodeMonoWavBase64(merged, this._pcmSampleRate || 16000);
  }

  _cleanupMediaResources() {
    this._recognitionStopping = true;
    if (this._durationTimer) {
      clearInterval(this._durationTimer);
      this._durationTimer = null;
    }
    if (this._analyserTimer) {
      clearInterval(this._analyserTimer);
      this._analyserTimer = null;
    }
    if (this._scriptProcessor) {
      try {
        this._scriptProcessor.disconnect();
      } catch {
        // ignore
      }
      this._scriptProcessor = null;
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
    this.audioLevels = [0.16, 0.22, 0.28, 0.35, 0.26, 0.18, 0.24, 0.32, 0.22, 0.16];
  }

  async stopRecording(overrideOptions = {}) {
    if (this.state !== 'recording') {
      return { stopped: false, reason: 'not-recording' };
    }

    this._recognitionStopping = true;
    if (this._recognition) {
      const rec = this._recognition;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(finish, 180);
        const prevOnEnd = rec.onend;
        rec.onend = (ev) => {
          clearTimeout(timer);
          if (typeof prevOnEnd === 'function') {
            try {
              prevOnEnd(ev);
            } catch {
              // ignore
            }
          }
          finish();
        };
        try {
          rec.stop();
        } catch {
          clearTimeout(timer);
          finish();
        }
      });
      this._recognition = null;
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
    const wavBase64 = this._buildCapturedWavBase64();
    this._mediaRecorder = null;
    this._cleanupMediaResources();

    this.state = 'transcribing';
    this.notify();

    try {
      let audioBase64 =
        overrideOptions.audioBase64 ??
        (recordedBlob ? await blobToBase64(recordedBlob) : '');
      if (
        (this.config.providerProtocol === 'browser-speech' ||
          this.config.providerProtocol === 'openai-chat-audio' ||
          !audioBase64) &&
        wavBase64
      ) {
        audioBase64 = wavBase64;
        mimeType = 'audio/wav';
      }

      const effectiveLiveText =
        typeof overrideOptions.liveTranscript === 'string'
          ? overrideOptions.liveTranscript
          : liveCaptured;

      let result = null;
      try {
        result = await this.invokeWorker('voice.transcribe', {
          audioBase64,
          wavBase64,
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

  cancelRecording() {
    this.previewDraft = null;
    this.liveInterimText = '';
    this.liveFinalSegments = [];
    this._recordedChunks = [];
    this._pcmChunks = [];
    if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
      try {
        this._mediaRecorder.stop();
      } catch {
        // ignore
      }
    }
    this._mediaRecorder = null;
    this._cleanupMediaResources();
    void this.invokeWorker('voice.cancel', {}).catch(() => {});
    this.state = 'idle';
    this.notify();
    return { cancelled: true };
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
    return this.cancelRecording();
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
                'inline-flex h-7 items-center justify-center rounded-md bg-primary/15 px-2 text-xs font-medium tabular-nums text-primary transition-colors hover:bg-primary/25',
            },
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
                'inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary',
            },
            h('span', {
              className:
                'h-3.5 w-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin',
            }),
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
              'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50',
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

      // 2. Status Bar Compact Popover View (`voice-input-status` view in `status.after-mcp`)
      function VoiceStatusPopoverView() {
        const snap = useVoiceSnapshot();
        const [recordingShortcut, setRecordingShortcut] = useState(false);
        const [triggerMenuOpen, setTriggerMenuOpen] = useState(false);

        const cfg = snap.config;
        const enabled = Boolean(cfg.enabled);
        const isRecording = snap.state === 'recording';
        const isTranscribing = snap.state === 'transcribing';
        const recordingModeOptions = [
          { value: 'toggle', label: '单击切换开始 / 结束' },
          { value: 'push-to-talk', label: '按住说话，松开即转写' },
        ];
        const currentRecordingModeLabel =
          (
            recordingModeOptions.find((opt) => opt.value === cfg.recordingMode) ||
            recordingModeOptions[0]
          ).label;

        useEffect(() => {
          if (!triggerMenuOpen || typeof window === 'undefined') return undefined;
          const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setTriggerMenuOpen(false);
            }
          };
          const handlePointerDown = (e) => {
            if (
              e.target &&
              typeof e.target.closest === 'function' &&
              !e.target.closest('[data-voice-trigger-select="true"]')
            ) {
              setTriggerMenuOpen(false);
            }
          };
          window.addEventListener('keydown', handleKeyDown, true);
          window.addEventListener('pointerdown', handlePointerDown, true);
          return () => {
            window.removeEventListener('keydown', handleKeyDown, true);
            window.removeEventListener('pointerdown', handlePointerDown, true);
          };
        }, [triggerMenuOpen]);

        useEffect(() => {
          if (!recordingShortcut || typeof window === 'undefined') return undefined;
          const handleKeyDown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
              setRecordingShortcut(false);
              return;
            }
            const nextSc = formatKeyboardEventToShortcut(e);
            if (nextSc) {
              persistAndSyncConfig({ shortcut: nextSc });
              setRecordingShortcut(false);
            }
          };
          window.addEventListener('keydown', handleKeyDown, true);
          return () => window.removeEventListener('keydown', handleKeyDown, true);
        }, [recordingShortcut]);

        const openPluginSettings = () => {
          try {
            if (
              typeof window !== 'undefined' &&
              window.__TAURI_INTERNALS__ &&
              typeof window.__TAURI_INTERNALS__.invoke === 'function'
            ) {
              void window.__TAURI_INTERNALS__.invoke('open_settings_window', {
                title: '设置',
                path: `/plugins/${PLUGIN_ID}`,
              });
              return;
            }
          } catch {
            // fallback
          }
          if (typeof window !== 'undefined') {
            window.location.hash = `#/plugins/${PLUGIN_ID}`;
          }
        };

        return h(
          'div',
          {
            className:
              'flex w-80 flex-col gap-3 bg-background p-3.5 text-xs text-foreground',
            'data-testid': 'voice-status-popover-studio',
          },
          // Header with Switch
          h(
            'div',
            {
              className:
                'flex items-center justify-between gap-2 border-b border-border/60 pb-2.5',
            },
            h(
              'div',
              { className: 'flex items-center gap-2' },
              h(
                'svg',
                {
                  viewBox: '0 0 24 24',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: '1.8',
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                  className: 'h-4 w-4 text-primary',
                },
                h('rect', { x: '9', y: '2', width: '6', height: '11', rx: '3' }),
                h('path', { d: 'M5 10a7 7 0 0 0 14 0' }),
                h('line', { x1: '12', y1: '17', x2: '12', y2: '21' }),
                h('line', { x1: '8', y1: '21', x2: '16', y2: '21' }),
              ),
              h('span', { className: 'text-xs font-semibold text-foreground' }, '语音输入'),
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                'aria-checked': enabled,
                'aria-label': '启用语音输入',
                'data-state': enabled ? 'checked' : 'unchecked',
                'data-testid': 'voice-status-enable-switch',
                onClick: () => persistAndSyncConfig({ enabled: !enabled }),
                className:
                  'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border bg-[var(--surface-control)] transition-colors data-[state=checked]:border-[var(--switch-checked-border)] data-[state=checked]:bg-[var(--switch-checked-track)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-0',
              },
              h('span', {
                'data-state': enabled ? 'checked' : 'unchecked',
                className:
                  'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-[var(--shadow-switch-thumb)] ring-0 transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-[var(--switch-checked-thumb)] data-[state=unchecked]:translate-x-0.5',
              }),
            ),
          ),

          // Quick Dictation Action Button
          h(
            'div',
            { className: 'flex flex-col gap-1.5' },
            h(
              'button',
              {
                type: 'button',
                onClick: () => void controller.toggleRecording(),
                disabled: !enabled || isTranscribing,
                className: isRecording
                  ? 'inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary/15 px-3 text-xs font-medium text-primary transition-colors hover:bg-primary/25'
                  : 'inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50',
              },
              isRecording
                ? `停止录音 (${snap.durationLabel})`
                : isTranscribing
                  ? '正在识别与润色…'
                  : `开始语音听写 (${cfg.shortcut})`,
            ),
            isRecording && snap.liveTranscript
              ? h(
                  'p',
                  {
                    className:
                      'truncate rounded bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground',
                  },
                  snap.liveTranscript,
                )
              : null,
            snap.lastError
              ? h(
                  'p',
                  { className: 'text-[11px] text-destructive' },
                  snap.lastError,
                )
              : null,
          ),

          // Recording Trigger Mode (Custom Select matching VibeX Select UI)
          h(
            'div',
            {
              className: 'relative flex flex-col gap-1.5',
              'data-voice-trigger-select': 'true',
            },
            h(
              'span',
              { className: 'text-[11px] font-medium text-muted-foreground' },
              '录音触发方式',
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'combobox',
                'aria-label': '录音触发方式',
                'aria-expanded': triggerMenuOpen,
                disabled: !enabled,
                onClick: () => setTriggerMenuOpen((open) => !open),
                className:
                  'raised-control flex h-8 w-full items-center justify-between rounded-[var(--_field-radius,var(--radius-element,var(--radius)))] border border-[var(--color-border-emphasized,var(--border-content))] bg-[var(--color-background-surface,var(--surface-control))] px-2.5 py-1 text-xs text-foreground transition-[border-color,background-color,box-shadow] focus:outline-none focus-visible:border-[var(--color-accent,hsl(var(--primary)))] disabled:cursor-not-allowed disabled:opacity-50',
              },
              h('span', { className: 'truncate' }, currentRecordingModeLabel),
              h(
                'svg',
                {
                  viewBox: '0 0 24 24',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: '2',
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                  className: 'h-3.5 w-3.5 shrink-0 opacity-50',
                },
                h('path', { d: 'm6 9 6 6 6-6' }),
              ),
            ),
            triggerMenuOpen
              ? h(
                  'div',
                  {
                    role: 'listbox',
                    'aria-label': '录音触发方式选项',
                    className:
                      'product-context-menu absolute left-0 right-0 top-[calc(100%+4px)] z-50 flex flex-col rounded-md border border-border bg-white p-1.5 font-sans text-xs leading-5 text-popover-foreground shadow-md dark:bg-popover',
                  },
                  ...recordingModeOptions.map((opt) => {
                    const selected = cfg.recordingMode === opt.value;
                    return h(
                      'button',
                      {
                        key: opt.value,
                        type: 'button',
                        role: 'option',
                        'aria-selected': selected,
                        'data-state': selected ? 'checked' : 'unchecked',
                        onClick: () => {
                          persistAndSyncConfig({ recordingMode: opt.value });
                          setTriggerMenuOpen(false);
                        },
                        className:
                          'astryx-select-option relative flex w-full cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left text-xs leading-5 text-popover-foreground outline-none transition-colors hover:bg-accent focus:bg-accent data-[state=checked]:font-medium',
                      },
                      h('span', { className: 'truncate' }, opt.label),
                      selected
                        ? h(
                            'svg',
                            {
                              viewBox: '0 0 24 24',
                              fill: 'none',
                              stroke: 'currentColor',
                              strokeWidth: '2',
                              strokeLinecap: 'round',
                              strokeLinejoin: 'round',
                              'aria-hidden': 'true',
                              className: 'astryx-select-option-check h-3.5 w-3.5 shrink-0',
                            },
                            h('path', { d: 'M20 6 9 17l-5-5' }),
                          )
                        : null,
                    );
                  }),
                )
              : null,
          ),

          // Shortcut Recorder
          h(
            'div',
            { className: 'flex flex-col gap-1.5' },
            h(
              'span',
              { className: 'text-[11px] font-medium text-muted-foreground' },
              '语音输入快捷键',
            ),
            h(
              'div',
              { className: 'flex items-center gap-1.5' },
              h('input', {
                type: 'text',
                'aria-label': '语音输入快捷键',
                readOnly: recordingShortcut,
                disabled: !enabled,
                value: recordingShortcut
                  ? '请按下快捷键组合 (Esc 取消)…'
                  : cfg.shortcut,
                onChange: (e) => {
                  if (!recordingShortcut) {
                    persistAndSyncConfig({ shortcut: e.target.value });
                  }
                },
                className:
                  'h-8 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground disabled:opacity-50',
              }),
              h(
                'button',
                {
                  type: 'button',
                  disabled: !enabled,
                  onMouseDown: (e) => e.preventDefault(),
                  onClick: () => setRecordingShortcut((v) => !v),
                  className:
                    'inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50',
                },
                recordingShortcut ? '取消录制' : '录制快捷键',
              ),
            ),
          ),

          // Footer link to full settings
          h(
            'div',
            {
              className:
                'flex items-center justify-end border-t border-border/60 pt-2',
            },
            h(
              'button',
              {
                type: 'button',
                onClick: openPluginSettings,
                className:
                  'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              },
              h('span', null, '前往设置修改'),
            ),
          ),
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

    // 3. Compact Translucent Frosted Glass Capsule HUD in DOM
    const VOICE_HUD_POSITION_STORAGE_KEY = 'vibex.voice-input.hud-position';
    const loadPersistedHudPosition = () => {
      try {
        if (typeof localStorage !== 'undefined') {
          const raw = localStorage.getItem(VOICE_HUD_POSITION_STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (
              parsed &&
              typeof parsed.left === 'number' &&
              Number.isFinite(parsed.left) &&
              typeof parsed.top === 'number' &&
              Number.isFinite(parsed.top)
            ) {
              return { left: parsed.left, top: parsed.top };
            }
          }
        }
      } catch {
        // ignore
      }
      return null;
    };
    const savePersistedHudPosition = (pos) => {
      try {
        if (
          typeof localStorage !== 'undefined' &&
          pos &&
          typeof pos.left === 'number' &&
          typeof pos.top === 'number'
        ) {
          localStorage.setItem(
            VOICE_HUD_POSITION_STORAGE_KEY,
            JSON.stringify({
              left: Math.round(pos.left),
              top: Math.round(pos.top),
            }),
          );
        }
      } catch {
        // ignore
      }
    };
    const clampHudPosition = (left, top, width = 148, height = 34) => {
      const vw =
        typeof window !== 'undefined' && window.innerWidth > 0
          ? window.innerWidth
          : 1280;
      const vh =
        typeof window !== 'undefined' && window.innerHeight > 0
          ? window.innerHeight
          : 800;
      const margin = 8;
      return {
        left: Math.max(margin, Math.min(vw - width - margin, left)),
        top: Math.max(margin, Math.min(vh - height - margin, top)),
      };
    };

    let hudRoot = null;
    let hudCancelBtn = null;
    let hudWaveContainer = null;
    let hudWaveBars = [];
    let hudConfirmBtn = null;
    let hudDragCleanup = null;

    const applyHudPositionStyle = (el) => {
      if (!el) return;
      const saved = loadPersistedHudPosition();
      if (saved) {
        const rect =
          typeof el.getBoundingClientRect === 'function'
            ? el.getBoundingClientRect()
            : { width: 148, height: 34 };
        const clamped = clampHudPosition(
          saved.left,
          saved.top,
          rect.width || 148,
          rect.height || 34,
        );
        el.style.left = `${clamped.left}px`;
        el.style.top = `${clamped.top}px`;
        el.style.bottom = 'auto';
        el.style.transform = 'none';
      } else {
        el.style.left = '50%';
        el.style.top = 'auto';
        el.style.bottom = '72px';
        el.style.transform = 'translateX(-50%)';
      }
    };

    const renderDomHud = (snap) => {
      if (typeof document === 'undefined' || !document.body) return;
      const shouldShow =
        snap.config.enabled &&
        snap.config.showFloatingHud &&
        (snap.state === 'recording' ||
          snap.state === 'transcribing' ||
          snap.state === 'preview');

      if (!shouldShow) {
        if (hudDragCleanup) {
          hudDragCleanup();
          hudDragCleanup = null;
        }
        if (hudRoot) {
          hudRoot.remove();
          hudRoot = null;
          hudCancelBtn = null;
          hudWaveContainer = null;
          hudWaveBars = [];
          hudConfirmBtn = null;
        }
        if (typeof document.querySelectorAll === 'function') {
          document
            .querySelectorAll('[data-vibex-voice-hud]')
            .forEach((node) => node.remove());
        }
        return;
      }

      const accentColor = 'var(--color-accent, hsl(var(--primary)))';
      const onAccentColor =
        'var(--color-on-accent, hsl(var(--primary-foreground, 0 0% 100%)))';

      if (!hudRoot) {
        hudRoot = document.createElement('div');
        hudRoot.setAttribute('data-vibex-voice-hud', 'true');
        hudRoot.style.cssText = [
          'position:fixed',
          'left:50%',
          'bottom:72px',
          'transform:translateX(-50%)',
          'z-index:2147483000',
          'height:34px',
          'padding:0 8px',
          'border-radius:999px',
          'background:color-mix(in srgb, var(--surface-popover, rgba(24,24,27,0.72)) 68%, transparent)',
          'color:var(--text-strong, #fafafa)',
          'border:1px solid color-mix(in srgb, var(--color-accent, hsl(var(--primary))) 28%, rgba(255,255,255,0.16))',
          'box-shadow:0 8px 24px rgba(0,0,0,0.22)',
          'display:inline-flex',
          'align-items:center',
          'justify-content:center',
          'gap:8px',
          'backdrop-filter:blur(16px) saturate(160%)',
          '-webkit-backdrop-filter:blur(16px) saturate(160%)',
          'user-select:none',
          'touch-action:none',
          'cursor:grab',
        ].join(';');
        applyHudPositionStyle(hudRoot);

        // Left button: X (Cancel)
        hudCancelBtn = document.createElement('button');
        hudCancelBtn.type = 'button';
        hudCancelBtn.setAttribute('aria-label', '取消语音输入');
        hudCancelBtn.setAttribute('data-testid', 'voice-hud-cancel');
        hudCancelBtn.style.cssText = [
          'width:22px',
          'height:22px',
          'border-radius:999px',
          'border:none',
          'background:color-mix(in srgb, var(--text-strong, #fafafa) 10%, transparent)',
          'color:var(--text-muted, rgba(161,161,170,0.95))',
          'display:inline-flex',
          'align-items:center',
          'justify-content:center',
          'cursor:pointer',
          'padding:0',
          'flex-shrink:0',
          'transition:background 0.15s ease, color 0.15s ease',
        ].join(';');
        hudCancelBtn.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
        hudCancelBtn.onpointerdown = (ev) => {
          ev.stopPropagation();
        };
        hudCancelBtn.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          controller.cancelRecording();
        };

        // Middle: Audio waveform bars in user accent color
        hudWaveContainer = document.createElement('div');
        hudWaveContainer.setAttribute('data-testid', 'voice-hud-waveform');
        hudWaveContainer.style.cssText = [
          'display:inline-flex',
          'align-items:center',
          'justify-content:center',
          'gap:2.5px',
          'height:18px',
          'padding:0 4px',
          'cursor:grab',
        ].join(';');

        hudWaveBars = Array.from({ length: 10 }, () => {
          const bar = document.createElement('span');
          bar.style.cssText = [
            'width:2.5px',
            'height:4px',
            'border-radius:999px',
            `background:${accentColor}`,
            'transition:height 75ms ease',
            'pointer-events:none',
          ].join(';');
          hudWaveContainer.appendChild(bar);
          return bar;
        });

        // Right button: Checkmark (Confirm / Complete)
        hudConfirmBtn = document.createElement('button');
        hudConfirmBtn.type = 'button';
        hudConfirmBtn.setAttribute('aria-label', '完成语音输入');
        hudConfirmBtn.setAttribute('data-testid', 'voice-hud-confirm');
        hudConfirmBtn.style.cssText = [
          'width:22px',
          'height:22px',
          'border-radius:999px',
          'border:none',
          `background:${accentColor}`,
          `color:${onAccentColor}`,
          'display:inline-flex',
          'align-items:center',
          'justify-content:center',
          'cursor:pointer',
          'padding:0',
          'flex-shrink:0',
          'transition:opacity 0.15s ease, transform 0.15s ease',
        ].join(';');
        hudConfirmBtn.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
        hudConfirmBtn.onpointerdown = (ev) => {
          ev.stopPropagation();
        };
        hudConfirmBtn.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (controller.state === 'recording') {
            void controller.stopRecording();
          } else if (controller.state === 'preview') {
            void controller.commitPreview(false);
          }
        };

        // Drag-to-move support on capsule body & waveform area
        let dragState = null;
        const onPointerMove = (ev) => {
          if (!dragState || !hudRoot) return;
          const dx = ev.clientX - dragState.startX;
          const dy = ev.clientY - dragState.startY;
          if (!dragState.moved && Math.hypot(dx, dy) < 3) return;
          dragState.moved = true;
          const clamped = clampHudPosition(
            dragState.initialLeft + dx,
            dragState.initialTop + dy,
            dragState.width,
            dragState.height,
          );
          dragState.currentLeft = clamped.left;
          dragState.currentTop = clamped.top;
          hudRoot.style.left = `${clamped.left}px`;
          hudRoot.style.top = `${clamped.top}px`;
          hudRoot.style.bottom = 'auto';
          hudRoot.style.transform = 'none';
        };
        const stopDrag = () => {
          if (!dragState) return;
          const finished = dragState;
          dragState = null;
          if (hudRoot) {
            hudRoot.style.cursor = 'grab';
          }
          if (hudWaveContainer) {
            hudWaveContainer.style.cursor = 'grab';
          }
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', stopDrag);
            window.removeEventListener('pointercancel', stopDrag);
          }
          if (finished.moved) {
            savePersistedHudPosition({
              left: finished.currentLeft,
              top: finished.currentTop,
            });
          }
        };
        hudDragCleanup = stopDrag;

        hudRoot.onpointerdown = (ev) => {
          if (ev.button !== undefined && ev.button !== 0) return;
          const target = ev.target;
          if (
            target &&
            typeof target.closest === 'function' &&
            target.closest('button')
          ) {
            return;
          }
          ev.preventDefault();
          const rect =
            typeof hudRoot.getBoundingClientRect === 'function'
              ? hudRoot.getBoundingClientRect()
              : {
                  left: parseFloat(hudRoot.style.left) || 200,
                  top: parseFloat(hudRoot.style.top) || 500,
                  width: 148,
                  height: 34,
                };
          const initialLeft = Number.isFinite(rect.left) ? rect.left : 200;
          const initialTop = Number.isFinite(rect.top) ? rect.top : 500;
          dragState = {
            startX: ev.clientX,
            startY: ev.clientY,
            initialLeft,
            initialTop,
            currentLeft: initialLeft,
            currentTop: initialTop,
            width: rect.width || 148,
            height: rect.height || 34,
            moved: false,
          };
          hudRoot.style.cursor = 'grabbing';
          if (hudWaveContainer) {
            hudWaveContainer.style.cursor = 'grabbing';
          }
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('pointermove', onPointerMove);
            window.addEventListener('pointerup', stopDrag);
            window.addEventListener('pointercancel', stopDrag);
          }
        };

        hudRoot.append(hudCancelBtn, hudWaveContainer, hudConfirmBtn);
        document.body.appendChild(hudRoot);
      }

      // Update dynamic waveform bar heights & confirm button state in place without destroying DOM nodes
      const levels =
        Array.isArray(snap.audioLevels) && snap.audioLevels.length > 0
          ? snap.audioLevels
          : [0.18, 0.28, 0.4, 0.55, 0.35, 0.25, 0.45, 0.3, 0.2, 0.16];
      hudWaveBars.forEach((bar, idx) => {
        const lvl = levels[idx] ?? 0.2;
        const effectiveLvl =
          snap.state === 'transcribing'
            ? 0.25 + 0.35 * Math.abs(Math.sin(Date.now() / 180 + idx * 0.6))
            : snap.state === 'preview'
              ? 0.45
              : lvl;
        const heightPx = Math.max(
          3,
          Math.min(16, Math.round(effectiveLvl * 16)),
        );
        bar.style.height = `${heightPx}px`;
      });

      if (hudConfirmBtn) {
        const isBusy = snap.state === 'transcribing';
        hudConfirmBtn.disabled = isBusy;
        hudConfirmBtn.style.cursor = isBusy ? 'wait' : 'pointer';
        hudConfirmBtn.style.opacity = isBusy ? '0.6' : '1';
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
      if (hudDragCleanup) {
        hudDragCleanup();
        hudDragCleanup = null;
      }
      if (hudRoot) {
        hudRoot.remove();
        hudRoot = null;
        hudCancelBtn = null;
        hudWaveContainer = null;
        hudWaveBars = [];
        hudConfirmBtn = null;
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
