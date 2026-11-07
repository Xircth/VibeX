function definePluginWorker(setup) {
  return {
    apiVersion: '2.0',
    setup,
  };
}

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  providerProtocol: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  triggerMode: 'auto',
  manualShortcut: 'Alt+\\',
  completionScope: 'smart',
  ignoredGlobs: '.env*, *.pem, *.key, *secret*, *.min.js',
  disabledLanguages: 'markdown, plaintext',
  maxTokens: 128,
  temperature: 0.1,
});

const MAX_SINGLE_LINE_LENGTH = 2000;
const CHARS_PER_TOKEN = 4;
const MAX_PREFIX_TOKENS = 600;
const MAX_SUFFIX_TOKENS = 200;
const MAX_NEIGHBOR_TOKENS = 200;
const MAX_NEIGHBOR_COUNT = 2;

const OPENAI_SYSTEM_PROMPT = [
  'You are an ultra-low-latency inline code completion engine (Fill-in-the-Middle).',
  'Your ONLY job is to output the exact code characters to insert at the cursor position between <PREFIX> and <SUFFIX>.',
  'Strict rules:',
  '1. Wrap your raw code continuation strictly inside <COMPLETION> and </COMPLETION> tags.',
  '2. NEVER output markdown code fences (```), language identifiers, explanations, or prose.',
  '3. NEVER repeat the code already present at the end of <PREFIX> or at the start of <SUFFIX>.',
  '4. If <PREFIX> ends with a function/method/class name or partial signature (e.g. `def calc_score`, `function parseData`), complete its parameters and body directly from the cursor.',
  '5. Preserve the exact indentation, naming conventions, and syntax of the surrounding file.',
].join('\n');

const ANTHROPIC_SYSTEM_PROMPT = [
  'You are an inline Fill-in-the-Middle (FIM) code completion engine.',
  'Continue the exact code at the cursor position between <PREFIX> and <SUFFIX>.',
  'Output ONLY raw code characters inside <COMPLETION>...</COMPLETION> and stop immediately with </COMPLETION>.',
  'Do NOT use markdown fences (```), do NOT explain, and do NOT repeat existing <PREFIX> or <SUFFIX> code.',
].join('\n');

/**
 * Convert a simple glob pattern (supporting `*` and `?`) into a RegExp.
 * Matches against either the full normalized path or the file basename.
 */
export function globToRegExp(globPattern) {
  const trimmed = String(globPattern || '').trim();
  if (!trimmed) return null;
  const escaped = trimmed
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Parse comma-separated globs and test whether `filePath` matches any ignored glob.
 */
export function isPrivacyIgnoredFile(filePath, ignoredGlobsInput = DEFAULT_CONFIG.ignoredGlobs) {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalizedPath = filePath.replace(/\\/g, '/').trim();
  const segments = normalizedPath.split('/').filter(Boolean);
  const basename = segments[segments.length - 1] || normalizedPath;

  const patterns = Array.isArray(ignoredGlobsInput)
    ? ignoredGlobsInput
    : String(ignoredGlobsInput || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

  for (const pattern of patterns) {
    const regex = globToRegExp(pattern);
    if (!regex) continue;
    if (regex.test(basename) || regex.test(normalizedPath)) {
      return true;
    }
    if (segments.some((segment) => regex.test(segment))) {
      return true;
    }
  }
  return false;
}

/**
 * Check whether the language is disabled in plugin configuration.
 */
export function isLanguageDisabled(languageId, disabledLanguagesInput = DEFAULT_CONFIG.disabledLanguages) {
  if (!languageId || typeof languageId !== 'string') return false;
  const normalized = languageId.trim().toLowerCase();
  const disabledSet = new Set(
    (Array.isArray(disabledLanguagesInput)
      ? disabledLanguagesInput
      : String(disabledLanguagesInput || '').split(',')
    )
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  return disabledSet.has(normalized);
}

/**
 * Determine whether the current cursor position should request a single-line or multi-line completion,
 * and compute appropriate dynamic stop sequences and max_tokens.
 */
export function resolveDynamicScope({
  prefix = '',
  suffix = '',
  completionScope = 'smart',
  maxTokens = DEFAULT_CONFIG.maxTokens,
} = {}) {
  const safeMaxTokens = Math.max(16, Math.min(1024, Number(maxTokens) || DEFAULT_CONFIG.maxTokens));
  const suffixLines = String(suffix).split('\n');
  const currentLineSuffix = suffixLines[0] || '';

  if (completionScope === 'single-line') {
    return {
      isSingleLine: true,
      maxTokens: Math.min(48, safeMaxTokens),
      stopSequences: ['\n', '\r\n'],
    };
  }

  // If non-closing tokens exist on the right side of the cursor on the same line
  // (e.g., inside function call arguments `foo(|, 0)`), constrain to single-line completion.
  // Otherwise (end of line, blank line, after a function name, or inside closing delimiters `)`, `):`, `}`, `];`),
  // allow smart multi-line completion at any position in code.
  const trimmedSuffixLine = currentLineSuffix.trim();
  const hasNonWhitespaceOnRight = trimmedSuffixLine.length > 0;
  const isOnlyClosingDelimitersOnRight =
    /^[}\]);,:\s]*$/.test(trimmedSuffixLine) && !trimmedSuffixLine.startsWith(',');

  if (hasNonWhitespaceOnRight && !isOnlyClosingDelimitersOnRight) {
    return {
      isSingleLine: true,
      maxTokens: Math.min(48, safeMaxTokens),
      stopSequences: ['\n', '\r\n'],
    };
  }

  return {
    isSingleLine: false,
    maxTokens: Math.min(160, Math.max(128, safeMaxTokens)),
    stopSequences: [],
  };
}

/**
 * Detect the indentation unit (`'    '`, `'  '`, or `'\t'`) used in the document prefix.
 */
function detectIndentationUnit(prefix = '', languageId = '') {
  const lines = String(prefix || '').split('\n');
  let fourSpaceCount = 0;
  let twoSpaceCount = 0;
  let tabCount = 0;

  for (let i = Math.max(0, lines.length - 40); i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const match = line.match(/^([ \t]+)/);
    if (!match) continue;
    const indent = match[1];
    if (indent.includes('\t')) {
      tabCount += 1;
    } else if (indent.length % 4 === 0) {
      fourSpaceCount += 1;
    } else if (indent.length % 2 === 0) {
      twoSpaceCount += 1;
    }
  }

  if (tabCount > fourSpaceCount && tabCount > twoSpaceCount) {
    return '\t';
  }
  const isFourSpaceLang =
    /^(python|rust)$/i.test(String(languageId || '').trim()) ||
    /\b(def |class |self\.|elif |import )/.test(prefix);
  if (isFourSpaceLang) {
    return twoSpaceCount > fourSpaceCount * 2 && twoSpaceCount >= 3 ? '  ' : '    ';
  }
  if (fourSpaceCount > twoSpaceCount) {
    return '    ';
  }
  return '  ';
}

/**
 * Normalize multi-line and next-line completion indentation so that:
 * 1. When the cursor is on a whitespace-only line (`N` spaces) and the model outputs a dedented block
 *    (`M < N` spaces, e.g. `    def step(self):` after pressing Enter on a 16-space `return pos` line),
 *    prepend `\n` so Monaco renders the dedented block at exact `M` spaces on the next line instead of
 *    gluing `M` spaces onto the existing `N` spaces (`N + M` spaces).
 * 2. When the cursor is on a whitespace-only line (`N` spaces) and the model outputs line 1 with 0 leading
 *    spaces (continuing from cursor) and lines 2+ with relative indentation (`< N`), add `N` spaces to lines 2+.
 * 3. When the cursor is at the end of a non-empty line (`N` spaces) and the model outputs a next-line block:
 *    - After a block header (`:` or `{`), ensure the child block is indented by at least `N + indentUnit`.
 *    - After `return`/`break`/`continue`/`raise`/`pass`, if the model outputs a new class method `def ...` at
 *      the wrong indentation (e.g. copying the `return` line's 16 spaces), align it to the class method indent.
 */
function normalizeCompletionIndentation(
  text,
  {
    prefix = '',
    currentLinePrefix = '',
    isSingleLine = false,
    hadLeadingNewlineInTag = false,
    languageId = '',
  } = {},
) {
  if (!text || isSingleLine || text.trim().length === 0) {
    return text;
  }

  const indentUnit = detectIndentationUnit(prefix, languageId);
  const indentStep = indentUnit.length;
  const trimmedCurrentPrefix = currentLinePrefix.trim();
  const currentIndent = currentLinePrefix.match(/^[ \t]*/)?.[0] || '';
  const currentIndentLen = currentIndent.length;

  // Case 1: Cursor is on a whitespace-only line with existing indentation (`currentIndentLen > 0`)
  if (trimmedCurrentPrefix.length === 0 && currentIndentLen > 0 && !text.startsWith('\n')) {
    const lines = text.split('\n');
    const firstLine = lines[0] || '';
    const firstLineIndent = (firstLine.match(/^[ \t]*/)?.[0] || '').length;

    // 1a. Model output a dedented block (`0 < firstLineIndent < currentIndentLen`, or top-level `def`/`class` at 0)
    const isTopLevelDeclarationAtZero =
      firstLineIndent === 0 &&
      /^(def |class |async def |@\w+|function |export |pub fn |fn )/.test(firstLine.trim());

    if (
      (firstLineIndent > 0 && firstLineIndent < currentIndentLen) ||
      isTopLevelDeclarationAtZero
    ) {
      return `\n${text}`;
    }

    // 1b. Model started line 1 at cursor (`firstLineIndent === 0`) and wrote lines 2+ with relative indentation
    if (firstLineIndent === 0 && lines.length > 1) {
      const firstNonEmptyRestIdx = lines.findIndex(
        (line, idx) => idx > 0 && line.trim().length > 0,
      );
      if (firstNonEmptyRestIdx !== -1) {
        const secondLine = lines[firstNonEmptyRestIdx];
        const secondLineIndent = (secondLine.match(/^[ \t]*/)?.[0] || '').length;
        const firstLineTrimmed = firstLine.trim();
        const firstLineOpensBlock =
          firstLineTrimmed.endsWith(':') || firstLineTrimmed.endsWith('{');
        const expectedMinSecondIndent = firstLineOpensBlock
          ? currentIndentLen + indentStep
          : currentIndentLen;

        if (secondLineIndent < expectedMinSecondIndent) {
          const adjustedLines = lines.map((line, idx) => {
            if (idx === 0 || line.trim().length === 0) return line;
            return `${currentIndent}${line}`;
          });
          return adjustedLines.join('\n');
        }
      }
    }

    return text;
  }

  // Case 2: Cursor is at the end of a non-empty line and completion starts on a new line (`text.startsWith('\n')`)
  if (trimmedCurrentPrefix.length > 0 && text.startsWith('\n')) {
    const leadingNewlinesMatch = text.match(/^(\n+)/);
    const leadingNewlines = leadingNewlinesMatch ? leadingNewlinesMatch[1] : '\n';
    const bodyText = text.slice(leadingNewlines.length);
    const bodyLines = bodyText.split('\n');
    const firstNonEmptyIdx = bodyLines.findIndex((line) => line.trim().length > 0);
    if (firstNonEmptyIdx === -1) {
      return text;
    }

    const firstNonEmptyLine = bodyLines[firstNonEmptyIdx];
    const firstNonEmptyTrimmed = firstNonEmptyLine.trim();
    const firstIndent = (firstNonEmptyLine.match(/^[ \t]*/)?.[0] || '').length;

    const isCurrentBlockOpener =
      trimmedCurrentPrefix.endsWith(':') || trimmedCurrentPrefix.endsWith('{');
    const isCurrentBlockTerminator =
      /^(return|break|continue|raise|pass)\b/.test(trimmedCurrentPrefix);

    // 2a. Current line opens a block (`def ...:`, `if ...:`, `while ...:`, `{`), so next line must be indented
    if (isCurrentBlockOpener) {
      const expectedIndentLen = currentIndentLen + indentStep;
      if (firstIndent < expectedIndentLen) {
        const delta = expectedIndentLen - firstIndent;
        const pad = ' '.repeat(delta);
        const reindented = bodyLines
          .map((line) => (line.trim().length > 0 ? `${pad}${line}` : ''))
          .join('\n');
        return `${leadingNewlines}${reindented}`;
      }
    }

    // 2b. Current line is `return ...` inside a class method, and completion starts a new method `def ...`
    if (
      isCurrentBlockTerminator &&
      /^(def |async def |@\w+)/.test(firstNonEmptyTrimmed)
    ) {
      // Find the indentation of the enclosing `def ` in prefix (typically 4 spaces inside a class, or 0 at module level)
      const prefixLines = String(prefix || '').split('\n');
      let enclosingDefIndentLen = 0;
      for (let i = prefixLines.length - 1; i >= 0; i -= 1) {
        const pLine = prefixLines[i];
        if (/^[ \t]*(def |async def )/.test(pLine)) {
          enclosingDefIndentLen = (pLine.match(/^[ \t]*/)?.[0] || '').length;
          break;
        }
      }
      if (firstIndent !== enclosingDefIndentLen) {
        const delta = enclosingDefIndentLen - firstIndent;
        const reindented = bodyLines
          .map((line) => {
            if (line.trim().length === 0) return '';
            if (delta > 0) {
              return `${' '.repeat(delta)}${line}`;
            }
            const lineIndent = (line.match(/^[ \t]*/)?.[0] || '').length;
            const removeCount = Math.min(lineIndent, Math.abs(delta));
            return line.slice(removeCount);
          })
          .join('\n');
        return `${leadingNewlines}${reindented}`;
      }
    }

    // 2c. Normal statement followed by a next-line sibling statement that lost its leading indentation (`firstIndent === 0`)
    if (
      !isCurrentBlockOpener &&
      !isCurrentBlockTerminator &&
      currentIndentLen > 0 &&
      firstIndent === 0 &&
      !/^(def |class |async def |@\w+|if __name__|export |function |import |from )/.test(
        firstNonEmptyTrimmed,
      )
    ) {
      const reindented = bodyLines
        .map((line) => (line.trim().length > 0 ? `${currentIndent}${line}` : ''))
        .join('\n');
      return `${leadingNewlines}${reindented}`;
    }
  }

  return text;
}

/**
 * Tokenize a code snippet into identifier/keyword tokens for Jaccard similarity scoring.
 */
function extractCodeTokens(text) {
  const matches = String(text || '').match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [];
  return new Set(matches.map((token) => token.toLowerCase()));
}

/**
 * Compute Jaccard similarity between two token sets.
 */
export function computeJaccardSimilarity(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Extract top import/use/include declarations from a file so types and symbols remain in context
 * even when the cursor is deep in the file.
 */
export function extractTopImports(fullTextOrPrefix, maxLines = 25) {
  const lines = String(fullTextOrPrefix || '').split('\n').slice(0, 80);
  const imports = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith('import ') ||
      trimmed.startsWith('from ') ||
      trimmed.startsWith('export ') ||
      trimmed.startsWith('use ') ||
      trimmed.startsWith('#include ') ||
      trimmed.startsWith('require(') ||
      trimmed.startsWith('const ') && trimmed.includes('require(')
    ) {
      imports.push(line);
      if (imports.length >= maxLines) break;
    }
  }
  return imports.join('\n');
}

/**
 * Assemble FIM context with token-budgeted prefix, suffix, top imports, and Jaccard-ranked neighbor snippets.
 */
export function buildFimContext({
  filePath = 'untitled',
  languageId = 'typescript',
  prefix = '',
  suffix = '',
  imports = '',
  neighbors = [],
  ignoredGlobs = DEFAULT_CONFIG.ignoredGlobs,
} = {}) {
  const maxPrefixChars = MAX_PREFIX_TOKENS * CHARS_PER_TOKEN;
  const maxSuffixChars = MAX_SUFFIX_TOKENS * CHARS_PER_TOKEN;
  const maxNeighborChars = MAX_NEIGHBOR_TOKENS * CHARS_PER_TOKEN;

  const truncatedPrefix =
    prefix.length > maxPrefixChars ? prefix.slice(prefix.length - maxPrefixChars) : prefix;
  const truncatedSuffix =
    suffix.length > maxSuffixChars ? suffix.slice(0, maxSuffixChars) : suffix;

  const cursorReferenceTokens = extractCodeTokens(
    `${truncatedPrefix.slice(-600)}\n${truncatedSuffix.slice(0, 300)}`,
  );

  const scoredNeighbors = (Array.isArray(neighbors) ? neighbors : [])
    .filter(
      (neighbor) =>
        neighbor &&
        typeof neighbor.content === 'string' &&
        neighbor.content.trim().length > 0 &&
        neighbor.filePath !== filePath &&
        !isPrivacyIgnoredFile(neighbor.filePath || '', ignoredGlobs),
    )
    .map((neighbor) => {
      const tokens = extractCodeTokens(neighbor.content);
      const score = computeJaccardSimilarity(cursorReferenceTokens, tokens);
      return {
        filePath: neighbor.filePath || 'neighbor',
        languageId: neighbor.languageId || languageId,
        content: neighbor.content.trim().slice(0, maxNeighborChars),
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_NEIGHBOR_COUNT);

  let neighborBudgetRemaining = maxNeighborChars;
  const selectedNeighbors = [];
  for (const item of scoredNeighbors) {
    if (neighborBudgetRemaining <= 0) break;
    const snippet = item.content.slice(0, neighborBudgetRemaining);
    neighborBudgetRemaining -= snippet.length;
    selectedNeighbors.push({
      filePath: item.filePath,
      languageId: item.languageId,
      score: Number(item.score.toFixed(4)),
      snippet,
    });
  }

  const extractedImports =
    imports && String(imports).trim().length > 0
      ? String(imports).trim()
      : extractTopImports(prefix);

  const hasImportsInTruncatedPrefix =
    !extractedImports || truncatedPrefix.includes(extractedImports);

  const promptSections = [
    `<FILE_METADATA>`,
    `path: ${filePath}`,
    `language: ${languageId}`,
    `</FILE_METADATA>`,
  ];

  if (selectedNeighbors.length > 0) {
    promptSections.push('<NEIGHBOR_SNIPPETS>');
    for (const neighbor of selectedNeighbors) {
      promptSections.push(`// File: ${neighbor.filePath}`);
      promptSections.push(neighbor.snippet);
    }
    promptSections.push('</NEIGHBOR_SNIPPETS>');
  }

  if (extractedImports && !hasImportsInTruncatedPrefix) {
    promptSections.push('<FILE_IMPORTS>');
    promptSections.push(extractedImports);
    promptSections.push('</FILE_IMPORTS>');
  }

  promptSections.push(
    `<FIM_TASK>`,
    `Complete the exact code at the cursor between <PREFIX> and <SUFFIX>.`,
    `Pay strict attention to the indentation level of <PREFIX> and <SUFFIX>.`,
    `Wrap the completion strictly in <COMPLETION>...</COMPLETION> without repeating <PREFIX> or <SUFFIX>.`,
    `<PREFIX>${truncatedPrefix}</PREFIX>`,
    `<SUFFIX>${truncatedSuffix}</SUFFIX>`,
    `</FIM_TASK>`,
  );

  return {
    userPrompt: promptSections.join('\n'),
    truncatedPrefix,
    truncatedSuffix,
    selectedNeighbors,
  };
}

/**
 * Normalize an API base URL and append the target endpoint path without duplicating `/v1`.
 */
export function resolveEndpointUrl(baseUrl, endpointPath) {
  const cleanBase = String(baseUrl || DEFAULT_CONFIG.baseUrl)
    .trim()
    .replace(/\/+$/, '');
  const cleanEndpoint = String(endpointPath || '').trim();

  if (cleanBase.endsWith('/v1') && cleanEndpoint.startsWith('/v1/')) {
    return `${cleanBase}${cleanEndpoint.slice(3)}`;
  }
  if (!cleanBase.endsWith('/v1') && !cleanEndpoint.startsWith('/v1/') && cleanEndpoint.startsWith('/')) {
    return `${cleanBase}/v1${cleanEndpoint}`;
  }
  return `${cleanBase}${cleanEndpoint.startsWith('/') ? '' : '/'}${cleanEndpoint}`;
}

/**
 * Build protocol-specific HTTP request payload (`url`, `headers`, `body`) for:
 * - `openai-compatible` (`POST /v1/chat/completions`)
 * - `anthropic-compatible` (`POST /v1/messages` with `<COMPLETION>` assistant prefill and `</COMPLETION>` stop sequence)
 * - `openai-fim` (`POST /v1/completions` native prompt + suffix FIM)
 */
export function buildProtocolHttpRequest({
  config = {},
  fimContext,
  dynamicScope,
}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const protocol = mergedConfig.providerProtocol || mergedConfig.protocol || 'openai-compatible';
  const model = String(mergedConfig.model || DEFAULT_CONFIG.model).trim();
  const apiKey = String(mergedConfig.apiKey || '').trim();
  const temperature =
    typeof mergedConfig.temperature === 'number' && !Number.isNaN(mergedConfig.temperature)
      ? mergedConfig.temperature
      : DEFAULT_CONFIG.temperature;
  const maxTokens = dynamicScope?.maxTokens ?? mergedConfig.maxTokens ?? DEFAULT_CONFIG.maxTokens;
  const extraStops = Array.isArray(dynamicScope?.stopSequences) ? dynamicScope.stopSequences : [];

  if (protocol === 'anthropic-compatible') {
    const url = resolveEndpointUrl(mergedConfig.baseUrl, '/v1/messages');
    const headers = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const stopSequences = Array.from(new Set(['</COMPLETION>', ...extraStops])).slice(0, 4);
    const body = {
      model,
      max_tokens: maxTokens,
      temperature,
      system: ANTHROPIC_SYSTEM_PROMPT,
      stop_sequences: stopSequences,
      messages: [
        {
          role: 'user',
          content: fimContext.userPrompt,
        },
        {
          role: 'assistant',
          content: '<COMPLETION>',
        },
      ],
    };
    return { protocol, url, headers, body };
  }

  if (protocol === 'openai-fim') {
    const url = resolveEndpointUrl(mergedConfig.baseUrl, '/v1/completions');
    const headers = {
      'content-type': 'application/json',
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const stop = Array.from(new Set(['</COMPLETION>', ...extraStops])).slice(0, 4);
    const body = {
      model,
      prompt: fimContext.truncatedPrefix,
      suffix: fimContext.truncatedSuffix,
      max_tokens: maxTokens,
      temperature,
      stop,
    };
    return { protocol, url, headers, body };
  }

  // Default: `openai-compatible` (`POST /v1/chat/completions`)
  const url = resolveEndpointUrl(mergedConfig.baseUrl, '/v1/chat/completions');
  const headers = {
    'content-type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  // Do not pass bare `\n` or `\r\n` to OpenAI chat completions since the model outputs `<COMPLETION>\n...`
  const safeOpenAiStops = extraStops.filter((seq) => seq !== '\n' && seq !== '\r\n');
  const stop = Array.from(new Set(['</COMPLETION>', ...safeOpenAiStops])).slice(0, 4);
  const disableThinking = /deepseek|bigmodel|glm|doubao|volces|ark|kimi|moonshot|qwen/i.test(
    `${mergedConfig.baseUrl || ''} ${model || ''}`,
  );
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    stop,
    ...(disableThinking ? { thinking: { type: 'disabled' } } : {}),
    messages: [
      {
        role: 'system',
        content: OPENAI_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: fimContext.userPrompt,
      },
    ],
  };

  return { protocol: 'openai-compatible', url, headers, body };
}

/**
 * Extract raw completion text from OpenAI Chat Completions, Anthropic Messages, or OpenAI FIM response JSON.
 */
export function extractRawCompletionFromResponse(protocol, payload) {
  if (!payload || typeof payload !== 'object') return '';

  if (protocol === 'anthropic-compatible') {
    if (Array.isArray(payload.content)) {
      return payload.content
        .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
        .join('');
    }
    if (typeof payload.completion === 'string') {
      return payload.completion;
    }
    return '';
  }

  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    const choice = payload.choices[0] || {};
    if (choice.message && typeof choice.message.content === 'string' && choice.message.content.length > 0) {
      return choice.message.content;
    }
    if (choice.message && typeof choice.message.reasoning_content === 'string') {
      const tagged = choice.message.reasoning_content.match(
        /<COMPLETION>[\s\S]*?<\/COMPLETION>/i,
      );
      if (tagged) {
        return tagged[0];
      }
    }
    if (choice.message && typeof choice.message.content === 'string') {
      return choice.message.content;
    }
    if (typeof choice.text === 'string') {
      return choice.text;
    }
  }

  if (typeof payload.content === 'string') {
    return payload.content;
  }

  return '';
}

/**
 * Deterministic Output Post-Processor:
 * 1. Extract content inside `<COMPLETION>...</COMPLETION>` or strip tags.
 * 2. Strip Markdown code fences (```lang ... ```).
 * 3. Deduplicate prefix overlap (current line before cursor or last line of prefix).
 * 4. Preserve or prepend `\n` when the cursor is at the end of a non-empty line and the completion is an indented next-line block.
 * 5. Normalize indentation across single-line, whitespace-only line, and multi-line completions.
 * 6. Deduplicate suffix overlap (current line after cursor, first non-empty line of suffix, or redundant closing brackets).
 * 7. Enforce single-line constraint if `isSingleLine` is true.
 */
export function postProcessCompletion(
  rawText,
  { prefix = '', suffix = '', isSingleLine = false, languageId = '' } = {},
) {
  if (typeof rawText !== 'string' || rawText.length === 0) {
    return '';
  }

  let text = rawText.replace(/\r\n/g, '\n');
  const hadLeadingNewlineInTag =
    /<COMPLETION>[ \t]*\n/i.test(text) || text.startsWith('\n');

  // 1. Extract `<COMPLETION>...</COMPLETION>` if present, or strip tags
  const taggedMatch = text.match(/<COMPLETION>([\s\S]*?)(?:\r?\n)?<\/COMPLETION>/i);
  if (taggedMatch) {
    text = taggedMatch[1];
  } else {
    text = text
      .replace(/^\s*<COMPLETION>/i, '')
      .replace(/(?:\r?\n)?<\/COMPLETION>\s*$/i, '');
  }

  // 2. Strip Markdown code fences (e.g. ```ts\n...\n```)
  const fenceMatch = text.match(/^\s*```[^\n]*\n([\s\S]*?)(?:\n```\s*|$)/);
  if (fenceMatch) {
    text = fenceMatch[1];
  } else {
    text = text.replace(/^\s*```[^\n]*\n?/, '').replace(/\n?```\s*$/, '');
  }

  const prefixLines = String(prefix).replace(/\r\n/g, '\n').split('\n');
  const currentLinePrefix = prefixLines[prefixLines.length - 1] || '';

  // Normalize leading blank lines (e.g. `\n    \n    def step` -> `\n\n    def step`)
  text = text.replace(/^(?:[ \t]*\n)+/, (match) => {
    const newlineCount = (match.match(/\n/g) || []).length;
    if (newlineCount >= 2 && currentLinePrefix.trim().length > 0) {
      return '\n\n';
    }
    return '\n';
  });

  // Trim a single leading newline before prefix-overlap deduplication
  if (text.startsWith('\n') && !text.startsWith('\n\n')) {
    text = text.slice(1);
  }

  // 3. Remove Prefix Overlap
  // 3a. Exact overlap with the text before the cursor on the current line
  if (currentLinePrefix.length > 0) {
    if (text.startsWith(currentLinePrefix)) {
      text = text.slice(currentLinePrefix.length);
    } else if (currentLinePrefix.trim().length > 0) {
      const trimmedCurrentPrefix = currentLinePrefix.trimStart();
      if (trimmedCurrentPrefix.length > 0 && text.startsWith(trimmedCurrentPrefix)) {
        text = text.slice(trimmedCurrentPrefix.length);
      } else {
        // Partial suffix-prefix overlap between end of currentLinePrefix and start of text (min 2 chars)
        const maxOverlap = Math.min(currentLinePrefix.length, text.length);
        for (let len = maxOverlap; len >= 2; len -= 1) {
          const tail = currentLinePrefix.slice(currentLinePrefix.length - len);
          if (tail.trim().length >= 2 && text.startsWith(tail)) {
            text = text.slice(len);
            break;
          }
        }
      }
    }
  }

  // 3b. If the first line of a multi-line completion duplicates the previous full line of prefix
  const previousPrefixLine =
    prefixLines.length >= 2 ? prefixLines[prefixLines.length - 2].trim() : '';
  if (previousPrefixLine.length >= 4) {
    const completionLines = text.split('\n');
    if (completionLines.length > 1 && completionLines[0].trim() === previousPrefixLine) {
      completionLines.shift();
      text = completionLines.join('\n');
    }
  }

  // 3c. When cursor is at the end of a non-empty line (`currentLinePrefix.trim().length > 0`)
  // and the completion is a next-line statement (starts with spaces/tab, or follows a comment / block header / return),
  // ensure it begins with `\n` so Monaco renders it on the next line rather than gluing it onto the current line.
  const trimmedLinePrefix = currentLinePrefix.trim();
  if (trimmedLinePrefix.length > 0 && !isSingleLine && !text.startsWith('\n') && text.trim().length > 0) {
    const isCommentLine =
      trimmedLinePrefix.startsWith('#') || trimmedLinePrefix.startsWith('//');
    const startsWithNextLineIndent = /^(?:  +|\t+)/.test(text);
    const isBlockHeaderNextLine =
      (trimmedLinePrefix.endsWith(':') || trimmedLinePrefix.endsWith('{')) &&
      hadLeadingNewlineInTag;
    const isBlockTerminatorNextLine =
      /^(return|break|continue|raise|pass)\b/.test(trimmedLinePrefix) &&
      hadLeadingNewlineInTag;

    if (
      isCommentLine ||
      startsWithNextLineIndent ||
      isBlockHeaderNextLine ||
      isBlockTerminatorNextLine
    ) {
      text = `\n${text}`;
    }
  }

  // 3d. Normalize indentation for whitespace-only lines, block headers, and dedented methods
  text = normalizeCompletionIndentation(text, {
    prefix,
    currentLinePrefix,
    isSingleLine,
    hadLeadingNewlineInTag,
    languageId,
  });

  // 4. Enforce single-line constraint when requested
  if (isSingleLine && text.includes('\n')) {
    const firstNonEmpty = text.split('\n').find((line) => line.trim().length > 0) || '';
    text = firstNonEmpty;
  }

  // 5. Remove Suffix Overlap
  const normalizedSuffix = String(suffix).replace(/\r\n/g, '\n');
  const suffixLines = normalizedSuffix.split('\n');
  const currentLineSuffix = suffixLines[0] || '';

  // 5a. Overlap with text immediately to the right of the cursor on the same line
  if (currentLineSuffix.length > 0) {
    if (text.endsWith(currentLineSuffix)) {
      text = text.slice(0, text.length - currentLineSuffix.length);
    } else {
      const maxSuffixOverlap = Math.min(text.length, currentLineSuffix.length);
      for (let len = maxSuffixOverlap; len >= 1; len -= 1) {
        const completionTail = text.slice(text.length - len);
        const suffixHead = currentLineSuffix.slice(0, len);
        if (completionTail === suffixHead) {
          text = text.slice(0, text.length - len);
          break;
        }
      }
    }
  }

  // 5b. Multi-line suffix line deduplication (when model repeats the closing brace or next statement of suffix)
  const nonEmptySuffixLines = suffixLines
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (nonEmptySuffixLines.length > 0 && text.includes('\n')) {
    const completionLines = text.split('\n');
    const lastCompletionLine = completionLines[completionLines.length - 1].trim();
    if (
      lastCompletionLine.length > 0 &&
      lastCompletionLine === nonEmptySuffixLines[0]
    ) {
      completionLines.pop();
      text = completionLines.join('\n');
    }
  }

  // 5c. Trim redundant closing brackets/quotes/semicolons that are already immediately after cursor
  const CLOSING_CHARS = new Set([')', ']', '}', '"', "'", '`', ';']);
  let suffixScanIndex = 0;
  while (
    text.length > 0 &&
    suffixScanIndex < currentLineSuffix.length &&
    CLOSING_CHARS.has(text[text.length - 1]) &&
    text[text.length - 1] === currentLineSuffix[suffixScanIndex]
  ) {
    text = text.slice(0, -1);
    suffixScanIndex += 1;
  }

  if (text.trim().length === 0) {
    return '';
  }

  return text;
}

/**
 * Execute HTTP request using either an injected `fetchImpl`, `fetch`, or `environment.host.call('network', 'fetch')`.
 */
async function performHttpRequest({ url, headers, body, signal, environment, fetchImpl }) {
  const effectiveFetch =
    typeof fetchImpl === 'function'
      ? fetchImpl
      : typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : null;

  if (effectiveFetch) {
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), 12000);
    const onParentAbort = () => timeoutController.abort();
    signal?.addEventListener?.('abort', onParentAbort, { once: true });
    const combinedSignal = signal ? timeoutController.signal : timeoutController.signal;

    try {
      let response = await effectiveFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
      if (
        !response.ok &&
        response.status === 400 &&
        body &&
        typeof body === 'object' &&
        'thinking' in body
      ) {
        const { thinking: _omitted, ...fallbackBody } = body;
        response = await effectiveFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(fallbackBody),
          signal: combinedSignal,
        });
      }
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(
          `Completion endpoint returned HTTP ${response.status}: ${errorBody.slice(0, 240)}`,
        );
      }
      return await response.json();
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener?.('abort', onParentAbort);
    }
  }

  if (environment?.host?.call) {
    const hostResponse = await environment.host.call('network', 'fetch', {
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (typeof hostResponse === 'string') {
      return JSON.parse(hostResponse);
    }
    if (hostResponse && typeof hostResponse.body === 'string') {
      return JSON.parse(hostResponse.body);
    }
    return hostResponse;
  }

  throw new Error('No fetch implementation available in worker runtime.');
}

/**
 * Stateful Completion Engine used by the plugin worker runtime and unit tests.
 */
export class CodeCompletionEngine {
  constructor({ config = {}, fetchImpl = null } = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.fetchImpl = fetchImpl;
    this.activeControllers = new Map();
    this.latestRequestId = null;
    this.metrics = {
      totalRequests: 0,
      completedRequests: 0,
      cancelledRequests: 0,
      filteredRequests: 0,
      errors: 0,
      lastError: null,
      lastLatencyMs: null,
    };
  }

  updateConfig(partialConfig = {}) {
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
    return {
      enabled: Boolean(this.config.enabled),
      providerProtocol: this.config.providerProtocol,
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      triggerMode: this.config.triggerMode,
      manualShortcut: this.config.manualShortcut,
      completionScope: this.config.completionScope,
      inFlightCount: this.activeControllers.size,
      metrics: { ...this.metrics },
    };
  }

  cancelRequest(requestId = null) {
    if (requestId && this.activeControllers.has(requestId)) {
      const controller = this.activeControllers.get(requestId);
      controller.abort();
      this.activeControllers.delete(requestId);
      this.metrics.cancelledRequests += 1;
      return { cancelled: true, requestId };
    }

    let cancelledCount = 0;
    for (const [id, controller] of this.activeControllers.entries()) {
      controller.abort();
      this.activeControllers.delete(id);
      cancelledCount += 1;
    }
    if (cancelledCount > 0) {
      this.metrics.cancelledRequests += cancelledCount;
    }
    return { cancelled: cancelledCount > 0, cancelledCount };
  }

  async complete(params = {}, environment = null) {
    const startTime = Date.now();
    this.metrics.totalRequests += 1;

    const effectiveConfig = {
      ...this.config,
      ...(params.config && typeof params.config === 'object' ? params.config : {}),
    };

    if (!effectiveConfig.enabled) {
      return {
        items: [],
        skippedReason: 'disabled',
      };
    }

    const filePath = String(params.filePath || params.uri || 'untitled');
    const languageId = String(params.languageId || 'plaintext');
    const prefix = String(params.prefix ?? '');
    const suffix = String(params.suffix ?? '');
    const requestId = String(params.requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);

    // 0. Check manual trigger mode
    if (!params.manual && effectiveConfig.triggerMode === 'manual') {
      this.metrics.filteredRequests += 1;
      return {
        items: [],
        requestId,
        skippedReason: 'manual-trigger-only',
      };
    }

    // 1. Privacy Guard: check ignored globs
    if (isPrivacyIgnoredFile(filePath, effectiveConfig.ignoredGlobs)) {
      this.metrics.filteredRequests += 1;
      return {
        items: [],
        requestId,
        skippedReason: 'privacy-ignored-glob',
      };
    }

    // 2. Check disabled languages (unless manual trigger explicitly overrides)
    if (!params.manual && isLanguageDisabled(languageId, effectiveConfig.disabledLanguages)) {
      this.metrics.filteredRequests += 1;
      return {
        items: [],
        requestId,
        skippedReason: 'language-disabled',
      };
    }

    // 3. Guard against minified / ultra-long single lines
    const currentLinePrefix = prefix.split('\n').pop() || '';
    if (currentLinePrefix.length > MAX_SINGLE_LINE_LENGTH) {
      this.metrics.filteredRequests += 1;
      return {
        items: [],
        requestId,
        skippedReason: 'line-too-long',
      };
    }

    // 4. Cancel any stale in-flight requests before starting the new one
    this.cancelRequest();

    const controller = new AbortController();
    this.activeControllers.set(requestId, controller);
    this.latestRequestId = requestId;

    try {
      const dynamicScope = resolveDynamicScope({
        prefix,
        suffix,
        completionScope: effectiveConfig.completionScope,
        maxTokens: effectiveConfig.maxTokens,
      });

      const fimContext = buildFimContext({
        filePath,
        languageId,
        prefix,
        suffix,
        imports: params.imports || '',
        neighbors: params.neighbors || [],
        ignoredGlobs: effectiveConfig.ignoredGlobs,
      });

      const httpRequest = buildProtocolHttpRequest({
        config: effectiveConfig,
        fimContext,
        dynamicScope,
      });

      const rawResponse = await performHttpRequest({
        url: httpRequest.url,
        headers: httpRequest.headers,
        body: httpRequest.body,
        signal: controller.signal,
        environment,
        fetchImpl: this.fetchImpl,
      });

      if (controller.signal.aborted) {
        return {
          items: [],
          requestId,
          cancelled: true,
        };
      }

      const rawCompletion = extractRawCompletionFromResponse(
        httpRequest.protocol,
        rawResponse,
      );

      const insertText = postProcessCompletion(rawCompletion, {
        prefix,
        suffix,
        isSingleLine: dynamicScope.isSingleLine,
        languageId,
      });

      this.metrics.completedRequests += 1;
      this.metrics.lastLatencyMs = Date.now() - startTime;
      this.metrics.lastError = null;

      if (!insertText) {
        return {
          items: [],
          requestId,
          protocol: httpRequest.protocol,
          model: effectiveConfig.model,
          latencyMs: this.metrics.lastLatencyMs,
        };
      }

      return {
        items: [
          {
            insertText,
            range: params.range || null,
          },
        ],
        insertText,
        requestId,
        protocol: httpRequest.protocol,
        model: effectiveConfig.model,
        isSingleLine: dynamicScope.isSingleLine,
        latencyMs: this.metrics.lastLatencyMs,
      };
    } catch (error) {
      const isAbort =
        controller.signal.aborted ||
        error?.name === 'AbortError' ||
        /aborted|cancelled/i.test(String(error?.message || ''));

      if (isAbort) {
        return {
          items: [],
          requestId,
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

export function createCodeCompletionWorkerDefinition(options = {}) {
  const engine = new CodeCompletionEngine(options);

  const workerDefinition = definePluginWorker((registrar, environment) => {
    const initialConfig =
      environment?.config?.get?.() ||
      environment?.context?.config ||
      {};
    if (initialConfig && typeof initialConfig === 'object') {
      engine.updateConfig(initialConfig);
    }

    registrar.onConfigUpdate((nextConfig) => {
      if (nextConfig && typeof nextConfig === 'object') {
        engine.updateConfig(nextConfig);
      }
    });

    registrar.handle('completion.complete', async (params, env) => {
      return await engine.complete(
        params && typeof params === 'object' ? params : {},
        env,
      );
    });

    registrar.handle('completion.cancel', async (params) => {
      const requestId =
        params && typeof params === 'object' && typeof params.requestId === 'string'
          ? params.requestId
          : null;
      return engine.cancelRequest(requestId);
    });

    registrar.handle('completion.status', async () => {
      return engine.getStatus();
    });

    registrar.handle('completion.configure', async (params) => {
      if (params && typeof params === 'object') {
        engine.updateConfig(params);
      }
      return engine.getStatus();
    });

    registrar.handle('completion.toggle', async (params) => {
      const nextEnabled =
        params && typeof params === 'object' && typeof params.enabled === 'boolean'
          ? params.enabled
          : !engine.getConfig().enabled;
      engine.updateConfig({ enabled: nextEnabled });
      return engine.getStatus();
    });

    registrar.handle('completion.trigger', async (params, env) => {
      const baseParams = params && typeof params === 'object' ? params : {};
      return await engine.complete({ ...baseParams, manual: true }, env);
    });

    registrar.onDispose(() => {
      engine.cancelRequest();
    });
  });

  return {
    engine,
    workerDefinition,
  };
}

const defaultWorker = createCodeCompletionWorkerDefinition();
export const engine = defaultWorker.engine;
export default defaultWorker.workerDefinition;
