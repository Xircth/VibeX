import { execFile } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

function definePluginWorker(setup) {
  return {
    apiVersion: '2.0',
    setup,
  };
}

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

export function buildWhisperPrompt(vocabulary, language = 'auto') {
  const terms = parseVocabularyList(vocabulary);
  const langKey = String(language || 'auto').trim().toLowerCase();
  if (terms.length === 0) {
    return langKey === 'en'
      ? 'Software engineering dictation with technical terminology.'
      : '软件研发与 AI 编程语音听写，请使用准确的标点符号与技术术语。';
  }
  const joined = terms.join(', ');
  if (langKey === 'en') {
    return `Technical glossary and preferred spellings: ${joined}.`;
  }
  return `技术术语与专有名词词表：${joined}。请保持专有名词大小写准确并添加规范标点。`;
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
      const spacedPattern = term
        .replace(/([a-z])([A-Z])/g, '$1\\s*$2')
        .split('')
        .map((ch) => (ch === '\\' || ch === 's' || ch === '*' ? ch : escapeRegExp(ch)))
        .join('');
      try {
        const rx = new RegExp(`\\b${spacedPattern}\\b`, 'gi');
        output = output.replace(rx, term);
      } catch {
        // Fallback to exact case-insensitive word match
        const fallbackRx = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
        output = output.replace(fallbackRx, term);
      }
    }
  }
  return output;
}

/**
 * Deterministic post-transcription cleanup:
 * - Removes spoken Chinese & English filler words ("嗯", "啊", "呃", "那个", "就是说", "um", "uh", "er")
 * - Collapses immediate stuttered word repetitions ("我我想要" -> "我想要", "the the" -> "the")
 * - Normalizes CJK / Latin spacing and punctuation
 * - Applies custom vocabulary canonical casing
 */
export function cleanTranscriptText(rawText, options = {}) {
  if (typeof rawText !== 'string') return '';
  let text = rawText.trim();
  if (!text) return '';

  const cleanupMode = options.cleanupMode || 'auto-clean';
  const vocabulary = options.vocabulary ?? DEFAULT_VOICE_CONFIG.vocabulary;

  if (cleanupMode === 'off') {
    return normalizeVocabularyTerms(text.replace(/\s+/g, ' ').trim(), vocabulary);
  }

  // 1. Strip leading/standalone spoken fillers in Chinese
  text = text.replace(
    /^(?:[嗯啊呃哦唉]+[，,、。\s]*)+/g,
    '',
  );
  text = text.replace(
    /(?:(?<=^)|(?<=[，,。！？；：、\s]))(?:嗯+|啊+|呃+|那个就是说|就是说呢|怎么说呢|然后呢就是)[，,、\s]*/g,
    '',
  );
  // Strip trailing modal filler particles when followed by punctuation
  text = text.replace(/\s*[嗯呃]+[，,、]+/g, '，');

  // 2. Strip English spoken fillers ("um", "uh", "er", "erm")
  text = text.replace(
    /\b(?:um+|uh+|er+|erm+|ah+)\b[,\s]*/gi,
    '',
  );

  // 3. Collapse immediate repeated words/characters from stuttering
  text = text.replace(/\b([A-Za-z]+)\s+\1\b/gi, '$1');
  text = text.replace(/([我你他她它这那])(?:\s*[，,、]?\s*\1)+/g, '$1');

  // 4. Normalize vocabulary / hotwords
  text = normalizeVocabularyTerms(text, vocabulary);

  // 5. Add clean spacing between CJK characters and ASCII words/numbers
  text = text.replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, '$1 $2');
  text = text.replace(/([A-Za-z0-9])([\u4e00-\u9fa5])/g, '$1 $2');

  // 6. Collapse redundant whitespace and duplicate punctuation
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/[，,]{2,}/g, '，');
  text = text.replace(/[。.]{2,}/g, (match) => (match.includes('...') ? '...' : '。'));
  text = text.replace(/^[，,、；;：:\s]+/, '').trim();

  // 7. Ensure terminal punctuation for complete sentences in Chinese if missing
  if (
    text.length >= 6 &&
    /[\u4e00-\u9fa5]$/.test(text) &&
    !/[。！？.!?:：；;，,]$/.test(text)
  ) {
    if (/^(?:请问|能不能|可以|如何|怎么|为什么|是不是|有没有)/.test(text) || /[吗呢]$/.test(text)) {
      text = `${text}？`;
    }
  }

  return text.trim();
}

export function decodeAudioPayload(audioBase64) {
  if (!audioBase64 || typeof audioBase64 !== 'string') {
    return new Uint8Array(0);
  }
  const cleaned = audioBase64.includes(',')
    ? audioBase64.slice(audioBase64.indexOf(',') + 1).trim()
    : audioBase64.trim();
  if (!cleaned) return new Uint8Array(0);
  return new Uint8Array(Buffer.from(cleaned, 'base64'));
}

export function resolveTranscriptionEndpoint(baseUrl, providerProtocol = 'openai-whisper') {
  const trimmed = String(baseUrl || DEFAULT_VOICE_CONFIG.baseUrl)
    .trim()
    .replace(/\/+$/, '');
  if (
    providerProtocol === 'groq-whisper' &&
    trimmed === 'https://api.openai.com/v1'
  ) {
    return 'https://api.groq.com/openai/v1/audio/transcriptions';
  }
  if (trimmed.endsWith('/audio/transcriptions')) {
    return trimmed;
  }
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/audio/transcriptions`;
  }
  return `${trimmed}/v1/audio/transcriptions`;
}

export function resolveChatCompletionsEndpoint(baseUrl) {
  const trimmed = String(baseUrl || DEFAULT_VOICE_CONFIG.baseUrl)
    .trim()
    .replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

export function buildMultipartAudioRequest({
  baseUrl,
  apiKey,
  providerProtocol = 'openai-whisper',
  model = 'gpt-4o-mini-transcribe',
  audioBase64 = '',
  mimeType = 'audio/webm',
  language = 'auto',
  vocabulary = '',
}) {
  const url = resolveTranscriptionEndpoint(baseUrl, providerProtocol);
  const effectiveModel =
    providerProtocol === 'groq-whisper' &&
    (!model || model === 'gpt-4o-mini-transcribe')
      ? 'whisper-large-v3-turbo'
      : model || 'whisper-1';

  const boundary = `----VibeXVoiceBoundary${Date.now().toString(16)}`;
  const audioBytes = decodeAudioPayload(audioBase64);
  const ext = mimeType.includes('wav')
    ? 'wav'
    : mimeType.includes('mp4') || mimeType.includes('m4a')
      ? 'm4a'
      : mimeType.includes('ogg')
        ? 'ogg'
        : 'webm';
  const prompt = buildWhisperPrompt(vocabulary, language);
  const langIso =
    language && language !== 'auto'
      ? String(language).split('-')[0].toLowerCase()
      : '';

  const textParts = [];
  const pushField = (name, value) => {
    if (value === undefined || value === null || value === '') return;
    textParts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`,
        'utf8',
      ),
    );
  };

  pushField('model', effectiveModel);
  pushField('response_format', 'json');
  if (langIso) {
    pushField('language', langIso);
  }
  if (prompt) {
    pushField('prompt', prompt);
  }

  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.${ext}"\r\nContent-Type: ${mimeType || 'audio/webm'}\r\n\r\n`,
    'utf8',
  );
  const fileFooter = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const bodyBuffer = Buffer.concat([
    ...textParts,
    fileHeader,
    Buffer.from(audioBytes),
    fileFooter,
  ]);

  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return {
    url,
    method: 'POST',
    headers,
    body: bodyBuffer,
    model: effectiveModel,
    prompt,
    language: langIso || 'auto',
  };
}

export function buildChatAudioRequest({
  baseUrl,
  apiKey,
  model = 'gpt-4o-audio-preview',
  audioBase64 = '',
  mimeType = 'audio/wav',
  language = 'auto',
  vocabulary = '',
  cleanupMode = 'auto-clean',
}) {
  const url = resolveChatCompletionsEndpoint(baseUrl);
  const cleanedBase64 = audioBase64.includes(',')
    ? audioBase64.slice(audioBase64.indexOf(',') + 1).trim()
    : String(audioBase64 || '').trim();
  const format = mimeType.includes('mp3') ? 'mp3' : 'wav';
  const prompt = buildWhisperPrompt(vocabulary, language);
  const instruction =
    cleanupMode === 'off'
      ? `Transcribe the user's speech verbatim. ${prompt} Output only the transcript text.`
      : `Transcribe the user's speech accurately, removing spoken filler words (such as um, uh, 嗯, 啊, 那个) and fixing technical terminology spelling. ${prompt} Output only the final transcript text without quotes or explanations.`;

  const headers = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const payload = {
    model: model || 'gpt-4o-audio-preview',
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          {
            type: 'input_audio',
            input_audio: {
              data: cleanedBase64,
              format,
            },
          },
        ],
      },
    ],
  };

  return {
    url,
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    model: payload.model,
  };
}

export function buildCleanupChatRequest({
  baseUrl,
  apiKey,
  model = 'gpt-4o-mini',
  rawText = '',
  language = 'auto',
  vocabulary = '',
}) {
  const url = resolveChatCompletionsEndpoint(baseUrl);
  const terms = parseVocabularyList(vocabulary);
  const glossaryNote =
    terms.length > 0
      ? `Preferred technical glossary: ${terms.join(', ')}.`
      : '';
  const systemPrompt = [
    'You are an intelligent voice dictation post-processor for a software engineering IDE (VibeX).',
    'Clean up the raw speech-to-text transcript:',
    '1. Remove spoken filler words, hesitations, and stutters (e.g. 嗯, 啊, 呃, 那个, 就是说, um, uh, you know).',
    '2. Preserve the speaker’s exact intent, language, and tone — do NOT answer questions or expand the prompt.',
    '3. Correct technical terms and product names using the glossary.',
    glossaryNote,
    'Output ONLY the cleaned transcript text without any quotes, markdown wrappers, or commentary.',
  ]
    .filter(Boolean)
    .join('\n');

  const headers = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const payload = {
    model: model || 'gpt-4o-mini',
    temperature: 0.1,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Language hint: ${language || 'auto'}\nRaw transcript:\n${rawText}`,
      },
    ],
  };

  return {
    url,
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    model: payload.model,
  };
}

export async function transcribeWithNativeOsSpeech(
  wavBase64,
  language = 'auto',
  signal = undefined,
) {
  const bytes = decodeAudioPayload(wavBase64);
  if (bytes.length < 44) return '';
  if (typeof process === 'undefined' || process.platform !== 'win32') {
    return '';
  }

  const tempWavPath = join(
    tmpdir(),
    `vibex-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
  );
  try {
    await writeFile(tempWavPath, bytes);
    const bcp47 = resolveBcp47Language(language);
    const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$wavPath = $env:VIBEX_VOICE_WAV_PATH
$cultureName = $env:VIBEX_VOICE_CULTURE
$recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
if (-not $recognizers -or $recognizers.Count -eq 0) { exit 0 }
$selected = $recognizers | Where-Object { $_.Culture.Name -eq $cultureName } | Select-Object -First 1
if (-not $selected) {
  $langPrefix = ($cultureName -split '-')[0]
  $selected = $recognizers | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $langPrefix } | Select-Object -First 1
}
if (-not $selected) { $selected = $recognizers | Select-Object -First 1 }
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($selected.Id)
$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$engine.SetInputToWaveFile($wavPath)
$segments = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt 30; $i++) {
  try {
    $res = $engine.Recognize()
    if ($null -eq $res) { break }
    if (-not [string]::IsNullOrWhiteSpace($res.Text)) {
      $segments.Add($res.Text.Trim())
    }
  } catch {
    break
  }
}
$engine.Dispose()
Write-Output ($segments -join ' ')
`;
    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
    const output = await new Promise((resolve) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encodedCommand,
        ],
        {
          encoding: 'utf8',
          timeout: 12000,
          windowsHide: true,
          signal,
          env: {
            ...process.env,
            VIBEX_VOICE_WAV_PATH: tempWavPath,
            VIBEX_VOICE_CULTURE: bcp47,
          },
        },
        (err, stdout) => {
          if (err) {
            resolve('');
            return;
          }
          resolve(String(stdout || '').trim());
        },
      );
    });
    return output;
  } catch {
    return '';
  } finally {
    await unlink(tempWavPath).catch(() => {});
  }
}

export class VoiceInputEngine {
  constructor(options = {}) {
    this.config = {
      ...DEFAULT_VOICE_CONFIG,
      ...(options.config && typeof options.config === 'object' ? options.config : {}),
    };
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.nativeOsTranscribeImpl =
      options.nativeOsTranscribeImpl || transcribeWithNativeOsSpeech;
    this.activeControllers = new Map();
    this.history = [];
    this.metrics = {
      totalTranscriptions: 0,
      completedTranscriptions: 0,
      cleanedTranscriptions: 0,
      cancelledTranscriptions: 0,
      errors: 0,
      lastError: null,
      lastLatencyMs: null,
      lastProviderUsed: null,
    };
  }

  updateConfig(partialConfig = {}) {
    if (!partialConfig || typeof partialConfig !== 'object') {
      return this.getConfig();
    }
    this.config = {
      ...this.config,
      ...partialConfig,
    };
    return this.getConfig();
  }

  getConfig() {
    return { ...this.config };
  }

  getStatus() {
    const enabled = Boolean(this.config.enabled);
    const protocol = this.config.providerProtocol || 'hybrid';
    const shortcut = this.config.shortcut || 'Alt+V';
    return {
      enabled,
      providerProtocol: protocol,
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      cleanupModel: this.config.cleanupModel,
      language: this.config.language,
      recordingMode: this.config.recordingMode,
      shortcut,
      cleanupMode: this.config.cleanupMode,
      vocabulary: this.config.vocabulary,
      audioDeviceId: this.config.audioDeviceId,
      showFloatingHud: Boolean(this.config.showFloatingHud),
      inFlightCount: this.activeControllers.size,
      historyCount: this.history.length,
      metrics: { ...this.metrics },
      text: enabled ? `语音输入 (${shortcut})` : '语音输入 (已禁用)',
      tooltip: enabled
        ? `AI 语音输入已就绪 · 协议: ${protocol} · 快捷键: ${shortcut}`
        : 'AI 语音输入已关闭，点击启用或配置',
    };
  }

  resolveEffectiveApiKey(overrideConfig = {}) {
    const explicit = String(
      overrideConfig.apiKey ?? this.config.apiKey ?? '',
    ).trim();
    if (explicit) return explicit;
    if (typeof process !== 'undefined' && process.env) {
      if (
        (overrideConfig.providerProtocol || this.config.providerProtocol) ===
          'groq-whisper' &&
        process.env.GROQ_API_KEY
      ) {
        return String(process.env.GROQ_API_KEY).trim();
      }
      if (process.env.OPENAI_API_KEY) {
        return String(process.env.OPENAI_API_KEY).trim();
      }
      if (process.env.VIBEX_API_KEY) {
        return String(process.env.VIBEX_API_KEY).trim();
      }
    }
    return '';
  }

  cancelRequest(requestId = null) {
    if (requestId && this.activeControllers.has(requestId)) {
      const controller = this.activeControllers.get(requestId);
      controller.abort();
      this.activeControllers.delete(requestId);
      this.metrics.cancelledTranscriptions += 1;
      return { cancelled: true, requestId };
    }
    let cancelledCount = 0;
    for (const [id, controller] of this.activeControllers.entries()) {
      controller.abort();
      this.activeControllers.delete(id);
      cancelledCount += 1;
    }
    if (cancelledCount > 0) {
      this.metrics.cancelledTranscriptions += cancelledCount;
    }
    return { cancelled: cancelledCount > 0, cancelledCount };
  }

  async cleanup(params = {}) {
    const effectiveConfig = {
      ...this.config,
      ...(params.config && typeof params.config === 'object' ? params.config : {}),
    };
    const rawText = String(params.rawText ?? params.text ?? '').trim();
    if (!rawText) {
      return {
        rawText: '',
        cleanedText: '',
        text: '',
        cleanupApplied: false,
      };
    }

    const deterministic = cleanTranscriptText(rawText, {
      cleanupMode: effectiveConfig.cleanupMode,
      vocabulary: effectiveConfig.vocabulary,
    });

    if (effectiveConfig.cleanupMode === 'off') {
      return {
        rawText,
        cleanedText: deterministic,
        text: deterministic,
        cleanupApplied: false,
        method: 'off',
      };
    }

    const apiKey = this.resolveEffectiveApiKey(effectiveConfig);
    const useLlmCleanup =
      Boolean(params.useLlm) &&
      Boolean(apiKey) &&
      typeof this.fetchImpl === 'function';

    if (useLlmCleanup) {
      try {
        const req = buildCleanupChatRequest({
          baseUrl: effectiveConfig.baseUrl,
          apiKey,
          model: effectiveConfig.cleanupModel || 'gpt-4o-mini',
          rawText: deterministic,
          language: effectiveConfig.language,
          vocabulary: effectiveConfig.vocabulary,
        });
        const response = await this.fetchImpl(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
        if (response.ok) {
          const data = await response.json();
          const llmText = String(
            data?.choices?.[0]?.message?.content ?? '',
          ).trim();
          if (llmText) {
            const normalizedLlm = normalizeVocabularyTerms(
              llmText,
              effectiveConfig.vocabulary,
            );
            this.metrics.cleanedTranscriptions += 1;
            return {
              rawText,
              cleanedText: normalizedLlm,
              text: normalizedLlm,
              cleanupApplied: normalizedLlm !== rawText,
              method: 'llm',
            };
          }
        }
      } catch {
        // Fall back to deterministic cleanup on network/LLM errors
      }
    }

    this.metrics.cleanedTranscriptions += 1;
    return {
      rawText,
      cleanedText: deterministic,
      text: deterministic,
      cleanupApplied: deterministic !== rawText,
      method: 'deterministic',
    };
  }

  async transcribe(params = {}) {
    const startTime = Date.now();
    this.metrics.totalTranscriptions += 1;

    const effectiveConfig = {
      ...this.config,
      ...(params.config && typeof params.config === 'object' ? params.config : {}),
    };

    if (!effectiveConfig.enabled) {
      return {
        text: '',
        rawText: '',
        cleanedText: '',
        skippedReason: 'disabled',
      };
    }

    const requestId = String(
      params.requestId || `voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    const controller = new AbortController();
    this.activeControllers.set(requestId, controller);

    try {
      const protocol = effectiveConfig.providerProtocol || 'hybrid';
      const apiKey = this.resolveEffectiveApiKey(effectiveConfig);
      const audioBase64 = String(params.audioBase64 || '').trim();
      const wavBase64 = String(
        params.wavBase64 || (params.mimeType === 'audio/wav' ? audioBase64 : ''),
      ).trim();
      const mimeType = String(params.mimeType || 'audio/webm').trim();
      const liveTranscript = String(
        params.liveTranscript ?? params.rawText ?? params.text ?? '',
      ).trim();

      let rawTranscript = '';
      let providerUsed = 'browser-speech';

      const canCallCloudAudio =
        Boolean(audioBase64) &&
        protocol !== 'browser-speech' &&
        (Boolean(apiKey) || Boolean(params.allowUnauthenticatedCloud)) &&
        typeof this.fetchImpl === 'function';

      if (canCallCloudAudio) {
        if (protocol === 'openai-chat-audio') {
          const chatReq = buildChatAudioRequest({
            baseUrl: effectiveConfig.baseUrl,
            apiKey,
            model: effectiveConfig.model || 'gpt-4o-audio-preview',
            audioBase64: wavBase64 || audioBase64,
            mimeType: wavBase64 ? 'audio/wav' : mimeType,
            language: effectiveConfig.language,
            vocabulary: effectiveConfig.vocabulary,
            cleanupMode: effectiveConfig.cleanupMode,
          });
          const res = await this.fetchImpl(chatReq.url, {
            method: chatReq.method,
            headers: chatReq.headers,
            body: chatReq.body,
            signal: controller.signal,
          });
          if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            throw new Error(
              `Chat Audio transcription failed (${res.status}): ${errBody || res.statusText}`,
            );
          }
          const json = await res.json();
          rawTranscript = String(
            json?.choices?.[0]?.message?.content ?? json?.text ?? '',
          ).trim();
          providerUsed = 'openai-chat-audio';
        } else {
          const multipartReq = buildMultipartAudioRequest({
            baseUrl: effectiveConfig.baseUrl,
            apiKey,
            providerProtocol:
              protocol === 'groq-whisper' ? 'groq-whisper' : 'openai-whisper',
            model: effectiveConfig.model,
            audioBase64,
            mimeType,
            language: effectiveConfig.language,
            vocabulary: effectiveConfig.vocabulary,
          });
          const res = await this.fetchImpl(multipartReq.url, {
            method: multipartReq.method,
            headers: multipartReq.headers,
            body: multipartReq.body,
            signal: controller.signal,
          });
          if (!res.ok) {
            if (protocol === 'hybrid' && liveTranscript) {
              rawTranscript = liveTranscript;
              providerUsed = 'hybrid-live-fallback';
            } else {
              const errBody = await res.text().catch(() => '');
              throw new Error(
                `Whisper transcription failed (${res.status}): ${errBody || res.statusText}`,
              );
            }
          } else {
            const json = await res.json();
            rawTranscript = String(json?.text ?? '').trim() || liveTranscript;
            providerUsed =
              protocol === 'groq-whisper' ? 'groq-whisper' : 'openai-whisper';
          }
        }
      } else {
        rawTranscript = liveTranscript;
        providerUsed =
          protocol === 'hybrid' ? 'hybrid-browser-speech' : 'browser-speech';

        if (
          !rawTranscript &&
          wavBase64 &&
          typeof this.nativeOsTranscribeImpl === 'function'
        ) {
          const osTranscript = await this.nativeOsTranscribeImpl(
            wavBase64,
            effectiveConfig.language,
            controller.signal,
          );
          if (osTranscript) {
            rawTranscript = osTranscript;
            providerUsed =
              protocol === 'hybrid' ? 'hybrid-os-speech' : 'os-speech';
          }
        }
      }

      const cleanupResult = await this.cleanup({
        rawText: rawTranscript,
        config: effectiveConfig,
        useLlm: Boolean(params.useLlmCleanup),
      });

      const finalText =
        effectiveConfig.cleanupMode === 'off'
          ? cleanupResult.rawText
          : cleanupResult.cleanedText;

      const latencyMs = Math.max(1, Date.now() - startTime);
      this.metrics.completedTranscriptions += 1;
      this.metrics.lastLatencyMs = latencyMs;
      this.metrics.lastProviderUsed = providerUsed;
      this.metrics.lastError = null;

      const entry = {
        id: requestId,
        timestamp: Date.now(),
        rawText: rawTranscript,
        cleanedText: cleanupResult.cleanedText,
        text: finalText,
        provider: providerUsed,
        language: effectiveConfig.language,
        cleanupMode: effectiveConfig.cleanupMode,
        latencyMs,
      };
      if (finalText) {
        this.history.unshift(entry);
        if (this.history.length > 25) {
          this.history.length = 25;
        }
      }

      return {
        ...entry,
        cleanupApplied: cleanupResult.cleanupApplied,
      };
    } catch (error) {
      const isAbort =
        controller.signal.aborted ||
        error?.name === 'AbortError' ||
        /aborted|cancelled/i.test(String(error?.message || ''));
      if (isAbort) {
        return {
          requestId,
          text: '',
          rawText: '',
          cleanedText: '',
          cancelled: true,
        };
      }
      this.metrics.errors += 1;
      this.metrics.lastError = String(error?.message || error);
      throw error;
    } finally {
      this.activeControllers.delete(requestId);
    }
  }
}

export function createVoiceInputWorkerDefinition(options = {}) {
  const engine = new VoiceInputEngine(options);

  const workerDefinition = definePluginWorker((registrar, environment) => {
    const initialConfig =
      environment?.config?.get?.() ||
      environment?.context?.config ||
      {};
    if (initialConfig && typeof initialConfig === 'object') {
      engine.updateConfig(initialConfig);
    }

    if (typeof registrar.onConfigUpdate === 'function') {
      registrar.onConfigUpdate((nextConfig) => {
        if (nextConfig && typeof nextConfig === 'object') {
          engine.updateConfig(nextConfig);
        }
      });
    }

    registrar.handle('voice.status', async () => {
      return engine.getStatus();
    });

    registrar.handle('voice.configure', async (params) => {
      if (params && typeof params === 'object') {
        engine.updateConfig(params);
      }
      return engine.getStatus();
    });

    registrar.handle('voice.toggle', async (params) => {
      const nextEnabled =
        params && typeof params === 'object' && typeof params.enabled === 'boolean'
          ? params.enabled
          : !engine.getConfig().enabled;
      engine.updateConfig({ enabled: nextEnabled });
      return engine.getStatus();
    });

    registrar.handle('voice.transcribe', async (params) => {
      return await engine.transcribe(
        params && typeof params === 'object' ? params : {},
      );
    });

    registrar.handle('voice.cleanup', async (params) => {
      return await engine.cleanup(
        params && typeof params === 'object' ? params : {},
      );
    });

    registrar.handle('voice.cancel', async (params) => {
      const requestId =
        params && typeof params === 'object' && typeof params.requestId === 'string'
          ? params.requestId
          : null;
      return engine.cancelRequest(requestId);
    });

    if (typeof registrar.onDispose === 'function') {
      registrar.onDispose(() => {
        engine.cancelRequest();
      });
    }
  });

  return {
    engine,
    workerDefinition,
  };
}

const defaultWorker = createVoiceInputWorkerDefinition();
export const engine = defaultWorker.engine;
export default defaultWorker.workerDefinition;

// Standalone stdio protocol 1.1 loop when executed as a child worker process by the VibeX Host
async function runStdioLoopIfMain(definition) {
  if (typeof process === 'undefined' || !process.argv?.[1]) return;
  let isMain = false;
  try {
    isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    isMain = false;
  }
  if (!isMain) return;

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const handlers = new Map();
  const disposables = [];
  let configUpdateListener = null;

  const send = (msg) => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({
        id: 'unknown',
        ok: false,
        error: { code: 'protocol_invalid', message: 'Invalid JSON message' },
      });
      continue;
    }

    if (!('method' in message)) continue;

    try {
      switch (message.method) {
        case 'initialize': {
          send({
            id: message.id,
            ok: true,
            result: {
              protocolVersion: '1.1',
              sdkVersion: '2.0',
              registrations: [],
              requestedFeatures: [],
            },
          });
          break;
        }
        case 'activate': {
          handlers.clear();
          const registrar = {
            handle(id, fn) {
              handlers.set(id, fn);
            },
            onConfigUpdate(fn) {
              configUpdateListener = fn;
            },
            onDispose(fn) {
              disposables.push(fn);
            },
          };
          await definition.setup(registrar, {
            context: message.params || {},
          });
          send({
            id: message.id,
            ok: true,
            result: { handlers: [...handlers.keys()].sort() },
          });
          break;
        }
        case 'config.volatile-update': {
          if (typeof configUpdateListener === 'function' && message.params?.config) {
            configUpdateListener(message.params.config);
          }
          send({
            id: message.id,
            ok: true,
            result: { updated: true },
          });
          break;
        }
        case 'invoke': {
          const fn = handlers.get(message.params?.handler);
          if (!fn) {
            send({
              id: message.id,
              ok: false,
              error: {
                code: 'handler_not_found',
                message: `Handler ${String(message.params?.handler)} is not registered`,
              },
            });
            break;
          }
          Promise.resolve(fn(message.params?.input, {}))
            .then((result) => send({ id: message.id, ok: true, result }))
            .catch((err) =>
              send({
                id: message.id,
                ok: false,
                error: {
                  code: 'worker_failed',
                  message: String(err?.message || err),
                },
              }),
            );
          break;
        }
        case 'dispose':
        case 'plugin.unload': {
          for (const d of disposables.splice(0)) {
            if (typeof d === 'function') await d();
          }
          handlers.clear();
          send({ id: message.id, ok: true, result: null });
          break;
        }
        case 'ping': {
          send({ id: message.id, ok: true, result: { apiVersion: '2.0' } });
          break;
        }
        default: {
          send({
            id: message.id,
            ok: false,
            error: {
              code: 'protocol_invalid',
              message: `Unknown method ${String(message.method)}`,
            },
          });
        }
      }
    } catch (err) {
      send({
        id: message.id,
        ok: false,
        error: {
          code: 'worker_failed',
          message: String(err?.message || err),
        },
      });
    }
  }
}

void runStdioLoopIfMain(defaultWorker.workerDefinition);
